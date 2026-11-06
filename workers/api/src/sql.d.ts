// A .sql file is imported as its text (the Text rule in wrangler.jsonc).
declare module '*.sql' {
  const text: string;
  export default text;
}
