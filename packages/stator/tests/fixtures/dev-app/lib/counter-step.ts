// Native-dev fixture: a helper a MACHINE imports. Editing it changes the
// machine's code hash even though no file under machines/ changed — the dev
// server must rebuild the store and existing sessions must start fresh.
export const STEP = 1
