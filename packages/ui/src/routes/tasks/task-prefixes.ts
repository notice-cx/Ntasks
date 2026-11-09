import { createContext } from 'react';

/**
 * The task id prefixes task text may link: the projects the page knows. It is
 * apart from the Markdown renderer, so a page that loads the renderer only on
 * demand, such as the board's composer, can still provide them.
 */
export const TaskPrefixes = createContext<ReadonlySet<string>>(new Set());
export const TaskPrefixesProvider = TaskPrefixes.Provider;
