import { ArrowDownWideNarrow, ArrowUpDown, ArrowUpNarrowWide } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import {
  DEFAULT_SORT_DIRECTIONS,
  directionLabel,
  SORT_LABELS,
  TASK_SORTS,
  type PageSort,
  type SortDirection,
} from '../../lib/task-sort';

const DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

/**
 * The Sort button: a menu of the orders, the one held ticked, then its two
 * directions in its own words (Newest first, A to Z). The button names the
 * order chosen, or Sort while each list keeps its own; Default order goes
 * back to that.
 */
export function SortMenu({ sort, onPick }: { sort: PageSort | null; onPick: (sort: PageSort | null) => void }) {
  const by = sort?.by ?? null;
  const Icon = sort === null ? ArrowUpDown : sort.direction === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  const name = sort === null ? 'Sort' : `Sort: ${SORT_LABELS[sort.by]}, ${directionLabel(sort.by, sort.direction)}`;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button aria-label={name} data-tasks-sort={sort === null ? '' : `${sort.by}-${sort.direction}`}>
          <Icon aria-hidden />
          <span className="max-sm:hidden">{sort === null ? 'Sort' : SORT_LABELS[sort.by]}</span>
        </Button>
      </MenuTrigger>
      <MenuContent label="Sort" align="end">
        {TASK_SORTS.map((option) => (
          <MenuItem
            key={option}
            checked={by === option}
            onSelect={() =>
              onPick({
                by: option,
                direction: option === by && sort !== null ? sort.direction : DEFAULT_SORT_DIRECTIONS[option],
              })
            }
          >
            {SORT_LABELS[option]}
          </MenuItem>
        ))}
        {sort === null ? null : (
          <>
            <MenuSeparator />
            {DIRECTIONS.map((direction) => (
              <MenuItem
                key={direction}
                checked={sort.direction === direction}
                onSelect={() => onPick({ by: sort.by, direction })}
              >
                {directionLabel(sort.by, direction)}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={() => onPick(null)}>Default order</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
