// Carry-over fixture: a helper the machine imports. The test appends a COMMENT
// here — the file changes (so the dev server rebuilds the store) but the
// machine's code hash doesn't (the hash ignores comments), so sessions must
// survive the rebuild.
export const STEP = 1
