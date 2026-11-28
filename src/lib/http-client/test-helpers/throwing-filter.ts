import { spyOn } from 'bun:test';
import * as utils from '../utils';

/** A `hosts` entry that marks the filter {@link makeMarkedFiltersThrow} fails. */
export const THROWING_FILTER_HOST = 'throwing-filter.invalid';

/**
 * Make matching any filter whose `hosts` includes {@link THROWING_FILTER_HOST} throw, as a
 * filter reading a hostile value at match time would - a malformed filter is refused when
 * it is registered, so this is how a filter that fails at run time is reached. Every
 * other filter matches as usual. Call `mockRestore()` on the result when done.
 */
export function makeMarkedFiltersThrow(): ReturnType<typeof spyOn> {
  const original = utils.matchesFilter;
  return spyOn(utils, 'matchesFilter').mockImplementation((filter, ...rest) => {
    if (filter.hosts?.includes(THROWING_FILTER_HOST)) {
      throw new Error('filter failed to match');
    }
    return original(filter, ...rest);
  });
}
