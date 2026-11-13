import { COMMENT_SUMMARY_MAX } from '@ntasks/domain';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { markdownPlainText, MarkdownText } from './task-markdown';

const TLDR = /^(?:TL;?DR:|\*\*TL;?DR:\*\*|\*\*TL;?DR\*\*:)[ \t]*(\S[^\r\n]*)\r?\n[ \t]*\r?\n(?=\s*\S)/iu;

function previewOf(source: string): string | null {
  const text = source.trim();
  const summary = TLDR.exec(text)?.[1];
  if (!summary && Array.from(text).length <= COMMENT_SUMMARY_MAX && text.split(/\r?\n/u, 4).length < 4) {
    return null;
  }

  const preview = markdownPlainText(summary ?? text);
  const characters = Array.from(preview);
  if (characters.length <= COMMENT_SUMMARY_MAX) return preview;

  const slice = characters.slice(0, COMMENT_SUMMARY_MAX - 1).join('');
  const space = slice.lastIndexOf(' ');
  return `${space >= slice.length - 20 ? slice.slice(0, space) : slice}…`;
}

export function CommentText({ source }: { source: string }) {
  const preview = useMemo(() => previewOf(source), [source]);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (preview === null) return <MarkdownText source={source} />;

  return (
    <div className="min-w-0">
      {!expanded && preview && <p className="m-0 text-body text-ink [overflow-wrap:anywhere]">{preview}</p>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ms-2"
        aria-controls={id}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        {expanded ? 'Hide full comment' : 'Show full comment'}
      </Button>
      <div id={id} hidden={!expanded}>
        {expanded && <MarkdownText source={source} />}
      </div>
    </div>
  );
}
