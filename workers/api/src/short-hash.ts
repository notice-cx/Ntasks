/** The first 12 hexadecimal characters of the SHA-256 of `text`: a version
 * name for a text, such as the task guide or a task's proposal. */
export async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).subarray(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
