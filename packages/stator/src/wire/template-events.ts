/**
 * The DOM events a server template's `on:` can bind. The page runtime
 * delegates exactly these from `<body>`, and each sends an event that carries
 * nothing from the browser: the payload was fixed when the page rendered.
 * An event that needs the browser's side of the story (which key, where the
 * pointer is) belongs in a client island.
 */
export const TEMPLATE_EVENTS = ['click', 'dblclick', 'submit', 'change', 'input'] as const
