import threads = require("node:worker_threads");
import path = require("node:path");

function createCurveWorker(): threads.Worker {
  // Workers run compiled SDK code, independent of the application's TS loaders,
  // eval flags and inspector port. This path is relative to the installed package.
  return new threads.Worker(path.join(__dirname, "curve.js"), { execArgv: [] });
}

export = { createCurveWorker };
