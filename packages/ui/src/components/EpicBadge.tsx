import { Badge } from './ui/badge';
import { TypeMark } from './ui/symbols';
import { cn } from '../lib/utils';

export function EpicBadge({ className }: { className?: string }) {
  return (
    <Badge
      icon={<TypeMark type="epic" size={12} label={null} />}
      className={cn('rounded-sm bg-hover px-1.5 font-semibold', className)}
    >
      Epic
    </Badge>
  );
}
