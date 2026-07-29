// Deliberately export-less: a file NAMED like a data route (.xml.ts) that
// exports nothing route-shaped. Discovery must error, not skip — the name
// makes it unambiguously a route file.
export const helper = 'not a route'
