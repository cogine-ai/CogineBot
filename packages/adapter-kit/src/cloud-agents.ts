/** A provider definitively rejected a request before starting remote work. */
export class CloudAgentRequestRejected extends Error {
  constructor() {
    super("Cloud agent request was rejected. Check the provider configuration and request.");
    this.name = "CloudAgentRequestRejected";
  }
}

/** The provider has definitively reported that a remote agent or run is unavailable. */
export class CloudAgentUnavailable extends Error {
  constructor(readonly reason: "not_found" | "expired") {
    super(
      reason === "expired" ? "Cloud agent work has expired." : "Cloud agent work was not found.",
    );
    this.name = "CloudAgentUnavailable";
  }
}

/** A retryable provider response, with evidence about whether the operation was rejected. */
export class CloudAgentRetryLater extends Error {
  constructor(
    readonly reason: "credential" | "rate_limit" | "unavailable",
    readonly retryAfterMs?: number,
    readonly requestRejected = true,
  ) {
    super(
      reason === "credential"
        ? "Cloud agent credential was rejected."
        : reason === "rate_limit"
          ? "Cloud agent requests are rate limited."
          : "Cloud agent provider is unavailable.",
    );
    this.name = "CloudAgentRetryLater";
  }
}
