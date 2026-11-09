// The id GitHub gives a Markdown heading, so a link written for GitHub, such
// as `sign-in.md#the-setup-page`, reaches the same heading on the site. GitHub
// lowercases the text, drops every character that is not a letter, a mark, a
// digit, a connector such as `_`, a hyphen or a space, and turns each space
// into a hyphen; it collapses nothing. markdown-it-anchor appends -1, -2 to a
// repeated id, as GitHub does.
export function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}
