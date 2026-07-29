/* Landing page: resolve the bot's @handle at runtime.
 *
 * The handle is not baked into the build — the landing page is served from
 * the same installation as the API, so it simply asks. Kept as a separate
 * file rather than an inline <script> so the page works under a strict
 * Content-Security-Policy without needing 'unsafe-inline'.
 */
(async () => {
	"use strict";

	const link = document.getElementById("open-bot");
	if (!link) return;
	link.href = "https://t.me";

	try {
		const response = await fetch("/api/public/bot", { cache: "no-store" });
		if (!response.ok) return;
		const data = await response.json();
		if (typeof data.username === "string" && /^[A-Za-z0-9_]{3,64}$/.test(data.username)) {
			link.href = `https://t.me/${data.username}`;
		}
	} catch {
		/* the landing page stays usable without the API */
	}
})();
