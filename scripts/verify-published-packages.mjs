import { verifyPublished } from "./release-artifacts.mjs";

await verifyPublished(process.env.RELEASE_MANIFEST_SHA256 || undefined);
