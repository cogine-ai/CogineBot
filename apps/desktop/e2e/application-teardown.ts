/** Settle attachment before closing the original applications, even when another close fails. */
export async function closePendingApplications<T>(
  pending: ReadonlySet<Promise<T>>,
  applications: ReadonlySet<T>,
  close: (application: T) => Promise<void>,
): Promise<unknown[]> {
  const settled = await Promise.allSettled([...pending]);
  const owned = new Set(applications);
  for (const result of settled) if (result.status === "fulfilled") owned.add(result.value);
  const errors: unknown[] = [];
  for (const application of owned) {
    try {
      await close(application);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
