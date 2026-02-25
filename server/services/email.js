'use strict';

const nodemailer = require('nodemailer');
const db = require('../database');

/**
 * Get a transporter for the given user's SMTP settings.
 * Returns null if SMTP is not configured / enabled for that user.
 */
function getTransporter(userId) {
  const user = db.prepare(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure, smtp_enabled
     FROM users WHERE id = ?`
  ).get(userId);

  if (!user || user.smtp_enabled !== 'true' || !user.smtp_host || !user.smtp_user)
    return null;

  return nodemailer.createTransport({
    host: user.smtp_host,
    port: parseInt(user.smtp_port) || 587,
    secure: user.smtp_secure === 'ssl',
    auth: { user: user.smtp_user, pass: user.smtp_pass },
    tls: user.smtp_secure === 'none' ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Send a signing invitation email.
 */
async function sendSigningInvite({ userId, envTitle, envMessage, emailSubject, signerName, signerEmail, signingUrl }) {
  const transport = getTransporter(userId);
  if (!transport) return { skipped: true, reason: 'SMTP not configured' };

  const u = db.prepare('SELECT smtp_from, smtp_user FROM users WHERE id = ?').get(userId);
  const fromAddr = u?.smtp_from || u?.smtp_user || 'signing@documentneo.local';
  const subject  = emailSubject || `Please sign: ${envTitle}`;

  await transport.sendMail({
    from: fromAddr,
    to: `${signerName} <${signerEmail}>`,
    subject,
    html: buildInviteHtml({ envTitle, envMessage, signerName, signingUrl }),
    text: buildInviteText({ envTitle, envMessage, signerName, signingUrl }),
  });

  return { sent: true };
}

/**
 * Send a reminder email to a signer who hasn't signed yet.
 */
async function sendSigningReminder({ userId, envTitle, signerName, signerEmail, signingUrl }) {
  const transport = getTransporter(userId);
  if (!transport) return { skipped: true, reason: 'SMTP not configured' };

  const u = db.prepare('SELECT smtp_from, smtp_user FROM users WHERE id = ?').get(userId);
  const fromAddr = u?.smtp_from || u?.smtp_user || 'signing@documentneo.local';

  await transport.sendMail({
    from: fromAddr,
    to: `${signerName} <${signerEmail}>`,
    subject: `Reminder: please sign "${envTitle}"`,
    html: buildReminderHtml({ envTitle, signerName, signingUrl }),
    text: buildReminderText({ envTitle, signerName, signingUrl }),
  });

  return { sent: true };
}

/**
 * Send the completion notification to the envelope owner.
 */
async function sendCompletionNotice({ userId, envTitle, ownerEmail, ownerName }) {
  const transport = getTransporter(userId);
  if (!transport) return { skipped: true };

  const u = db.prepare('SELECT smtp_from, smtp_user FROM users WHERE id = ?').get(userId);
  const fromAddr = u?.smtp_from || u?.smtp_user || 'signing@documentneo.local';

  await transport.sendMail({
    from: fromAddr,
    to: `${ownerName} <${ownerEmail}>`,
    subject: `✅ All signatures collected: "${envTitle}"`,
    html: `<p>Hi ${ownerName},</p><p>All signers have completed signing <strong>${envTitle}</strong>. Log in to download the signed document.</p>`,
    text: `Hi ${ownerName}, all signers have completed signing "${envTitle}". Log in to download the signed document.`,
  });

  return { sent: true };
}

/**
 * Send signed PDF copy to all signers on completion.
 */
async function sendSignedCopy({ userId, envTitle, signers, pdfBuffer }) {
  const transport = getTransporter(userId);
  if (!transport) return { skipped: true };

  const u = db.prepare('SELECT smtp_from, smtp_user FROM users WHERE id = ?').get(userId);
  const fromAddr = u?.smtp_from || u?.smtp_user || 'signing@documentneo.local';

  const results = [];
  for (const s of signers) {
    try {
      await transport.sendMail({
        from: fromAddr,
        to: `${s.name} <${s.email}>`,
        subject: `Signed copy: "${envTitle}"`,
        html: `<p>Hi ${s.name},</p><p>All parties have signed <strong>${envTitle}</strong>. Your signed copy is attached.</p>`,
        text: `Hi ${s.name}, all parties have signed "${envTitle}". Your signed copy is attached.`,
        attachments: [{
          filename: `${envTitle.replace(/[^a-z0-9]/gi,'_')}_signed.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        }],
      });
      results.push({ email: s.email, sent: true });
    } catch (e) {
      results.push({ email: s.email, error: e.message });
    }
  }
  return results;
}

/** Test SMTP connection – used from the settings UI */
async function testSmtp(userId) {
  const transport = getTransporter(userId);
  if (!transport) throw new Error('SMTP is not enabled or not fully configured.');
  await transport.verify();
  return true;
}

/* ── Email templates ──────────────────────────────────────────────────────── */
function buildInviteHtml({ envTitle, envMessage, signerName, signingUrl }) {
  return `
<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:24px">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#6366f1;padding:24px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px">Document Signing Request</h1>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 16px">Hi <strong>${escH(signerName)}</strong>,</p>
    <p style="margin:0 0 8px">You've been asked to sign <strong>${escH(envTitle)}</strong>.</p>
    ${envMessage ? `<p style="color:#555;font-style:italic;margin:0 0 24px">"${escH(envMessage)}"</p>` : '<br>'}
    <a href="${signingUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Review &amp; Sign Document →</a>
    <p style="margin:24px 0 0;font-size:12px;color:#888">Or paste this link into your browser:<br><span style="color:#6366f1">${signingUrl}</span></p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:11px;color:#aaa">Powered by DocumentNeo. This link is unique to you — do not share it.</p>
  </div>
</div>
</body></html>`;
}

function buildInviteText({ envTitle, envMessage, signerName, signingUrl }) {
  return `Hi ${signerName},\n\nYou've been asked to sign: ${envTitle}.\n${envMessage ? `\n"${envMessage}"\n` : ''}\nSign here: ${signingUrl}\n\nThis link is unique to you — do not share it.`;
}

function buildReminderHtml({ envTitle, signerName, signingUrl }) {
  return `
<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:24px">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#f59e0b;padding:24px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px">Signing Reminder</h1>
  </div>
  <div style="padding:32px">
    <p>Hi <strong>${escH(signerName)}</strong>,</p>
    <p>Just a reminder — <strong>${escH(envTitle)}</strong> is still waiting for your signature.</p>
    <a href="${signingUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Sign Now →</a>
    <p style="margin:24px 0 0;font-size:12px;color:#888">Link: <span style="color:#6366f1">${signingUrl}</span></p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="font-size:11px;color:#aaa">Powered by DocumentNeo. This link is unique to you — do not share it.</p>
  </div>
</div>
</body></html>`;
}

function buildReminderText({ envTitle, signerName, signingUrl }) {
  return `Hi ${signerName},\n\nReminder: "${envTitle}" is still waiting for your signature.\n\nSign here: ${signingUrl}\n\nThis link is unique to you.`;
}

function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

module.exports = { sendSigningInvite, sendSigningReminder, sendCompletionNotice, sendSignedCopy, testSmtp };
