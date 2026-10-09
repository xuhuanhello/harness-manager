/** Input limits enforced once, at the IPC boundary. Values match what the app already accepted. */
export const LIMITS = {
  idLength: 512,
  pathLength: 4096,
  nameLength: 80,
  iconLength: 32,
  urlLength: 2048,
  scanUriLength: 2048,
  refLength: 512,
  subpathLength: 1024,
  selection: 5000,
  searchQueryLength: 200,
  catalogMaxPage: 99,
  settingsKeyLength: 128,
  settingsValueLength: 256,
  commandLength: 100,
  versionArgs: 8,
  versionArgLength: 100,
  pathListEntries: 20,
  identityEntries: 10,
  identityLength: 200,
} as const;

/** Persisted identifier formats. */
export const ID_PATTERNS = {
  skill: /^skill_[a-f0-9]{64}$/,
  source: /^source_[a-f0-9]{64}$/,
  group: /^group_[0-9a-f-]{36}$/,
  uuid: /^[0-9a-f-]{36}$/,
  external: /^external-[a-f0-9]{32}$/,
  harness: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
} as const;

export const CONTROL_CHARACTERS = /[\u0000-\u001f]/;
