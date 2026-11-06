/**
 * AGPL-3.0 section 13 requires a modified copy that people use over a network
 * to offer them its source, so every version of the app links to it.
 */
const SOURCE_URL = 'https://github.com/notice-cx/Ntasks';

export function App() {
  return (
    <main>
      <h1>Ntasks</h1>
      <p>A task hub for people and AI agents.</p>
      <footer>
        <a href={SOURCE_URL}>Source code</a>
      </footer>
    </main>
  );
}
