'use strict';

export const State = {
  view:                'grid',
  currentNav:          'documents',
  page:                1,
  limit:               24,
  total:               0,
  searchQ:             '',
  filterTag:           null,
  filterType:          null,
  filterCorrespondent: null,
  sortField:           'created_at',
  sortOrder:           'desc',
  tags:                [],
  types:               [],
  correspondents:      [],
  userPrefs:           {
    pref_ai_custom_instructions: '',
    totp_enabled:                false,
  },
  searchTimer:         null,
  // Mass selection
  selectedDocs:        new Set(),
  selectMode:          false,
  // Chat / RAG
  chatMessages:        [],
  chatLoading:         false,
};
