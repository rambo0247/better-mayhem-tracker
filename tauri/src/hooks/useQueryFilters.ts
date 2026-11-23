import { useSearchParams } from "@solidjs/router";

// The Total Stats pages keep their filters in the query string rather than in
// view state: the list hands them to a champion page in its link, and the
// champion page's back link hands them back, whether or not filters are being
// remembered.
export function useQueryFilters() {
  const [searchParams, setSearchParams] = useSearchParams<Record<string, string>>();

  const setParam = (key: string, value: string | number | undefined) => {
    setSearchParams(
      { [key]: value == null || value === "" ? undefined : String(value) },
      {
        replace: true,
      },
    );
  };

  return {
    searchParams,
    setSearchParams,
    setParam,
    patch: () => searchParams.patch ?? undefined,
    queue: () => (searchParams.queue ? Number(searchParams.queue) : undefined),
  };
}
