import { toast } from 'sonner';

/**
 * Copies `text` and says so, naming it `what` ("web-a1b2", "the link"). A
 * page served without HTTPS has no clipboard, and a browser can refuse the
 * write: then it says it could not.
 */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('No clipboard');
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error(`Could not copy ${what}`);
    return;
  }
  toast.success(`Copied ${what}`);
}
