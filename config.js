// TillTally runtime configuration.
//
// Leave apiUrl empty to run in LOCAL-ONLY mode: all data stays in this
// browser's storage on this device, no sync. To share one household between
// two phones, deploy the Worker in worker/ (see README) and either set
// apiUrl here before hosting, or paste the Worker URL into the app's
// Settings tab on each phone (that in-app setting wins and is stored
// per-device, so it never needs to live in the repo).
window.TILLTALLY_CONFIG = {
  apiUrl: "https://tilltally-api.haydenlockwood.workers.dev",
  householdCode: "",
  // Stamped at deploy time by scripts/deploy-pages.sh (same value that goes
  // into the service-worker cache name); shown in Settings so you can see
  // an update landed. "__TILLTALLY_VERSION__" in the repo copy = unstamped.
  version: "__TILLTALLY_VERSION__"
};
