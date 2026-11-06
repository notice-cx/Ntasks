// Run by `node --test`, not Vitest: Vitest loads modules through Vite, which
// accepts imports that Node refuses. Importing the package by its own name
// goes through package.json's exports, as a Node script that uses it would.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTaskId } from '@ntasks/domain';

test('Node imports the package by its name, with no bundler', () => {
  assert.equal(isTaskId('web-a1b2'), true);
  assert.equal(isTaskId('web-app-a3f8e9'), false);
});
