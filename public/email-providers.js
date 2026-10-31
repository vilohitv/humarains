/* Mail provider presets for onboarding: pick Gmail, Outlook, etc. and the server settings fill themselves in.
   Works in the browser (window.HumEmailProviders) and in Node (the tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HumEmailProviders = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var PROVIDERS = [
    { key: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
      imapHost: 'imap.gmail.com', imapPort: '993', smtpHost: 'smtp.gmail.com', smtpPort: '587',
      secretLabel: 'App password',
      help: 'Gmail needs an app password, not your normal one. Turn on 2-step verification, then create one.',
      helpUrl: 'https://myaccount.google.com/apppasswords', helpLabel: 'Create a Gmail app password' },
    { key: 'outlook', name: 'Outlook', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
      imapHost: 'outlook.office365.com', imapPort: '993', smtpHost: 'smtp.office365.com', smtpPort: '587',
      secretLabel: 'App password',
      help: 'Outlook and Microsoft 365 need an app password. Some work accounts block this; if so, ask your IT admin or use another inbox.',
      helpUrl: 'https://support.microsoft.com/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9', helpLabel: 'How to create an Outlook app password' },
    { key: 'yahoo', name: 'Yahoo', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
      imapHost: 'imap.mail.yahoo.com', imapPort: '993', smtpHost: 'smtp.mail.yahoo.com', smtpPort: '587',
      secretLabel: 'App password',
      help: 'Yahoo needs an app password generated from your account security page.',
      helpUrl: 'https://help.yahoo.com/kb/SLN15241.html', helpLabel: 'How to create a Yahoo app password' },
    { key: 'icloud', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'],
      imapHost: 'imap.mail.me.com', imapPort: '993', smtpHost: 'smtp.mail.me.com', smtpPort: '587',
      secretLabel: 'App-specific password',
      help: 'iCloud needs an app-specific password.',
      helpUrl: 'https://support.apple.com/102654', helpLabel: 'How to create an app-specific password' },
    { key: 'other', name: 'Other', domains: [],
      imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '587',
      secretLabel: 'Password',
      help: 'Enter your mail server details below. Your email host can tell you the IMAP and SMTP addresses.',
      helpUrl: '', helpLabel: '' },
  ];

  function byKey(key) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].key === key) return PROVIDERS[i];
    return PROVIDERS[PROVIDERS.length - 1];
  }

  // Guess the provider from what the person typed. Unknown domains (a business address) return 'other'.
  function detect(email) {
    var m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
    if (!m) return null;
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].domains.indexOf(m[1]) !== -1) return PROVIDERS[i].key;
    return 'other';
  }

  // The body the connect endpoint expects. App passwords are often pasted with spaces ("abcd efgh ..."); strip them for known providers.
  function buildPayload(providerKey, f) {
    var p = byKey(providerKey);
    var secret = String(f.pass || '');
    if (p.key !== 'other') secret = secret.replace(/\s+/g, '');
    return {
      user: String(f.user || '').trim(),
      pass: secret,
      imapHost: String(f.imapHost || p.imapHost).trim(),
      imapPort: String(f.imapPort || p.imapPort).trim(),
      smtpHost: String(f.smtpHost || p.smtpHost).trim(),
      smtpPort: String(f.smtpPort || p.smtpPort).trim(),
      fromName: String(f.fromName || '').trim(),
    };
  }

  function validate(payload) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.user)) return 'Enter the full email address, like you@company.com.';
    if (!payload.pass) return 'Enter the password for this inbox.';
    if (!payload.imapHost || !payload.smtpHost) return 'Enter both the IMAP and SMTP server addresses.';
    return null;
  }

  return { PROVIDERS: PROVIDERS, byKey: byKey, detect: detect, buildPayload: buildPayload, validate: validate };
});
