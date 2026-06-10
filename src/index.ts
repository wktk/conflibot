import * as core from "@actions/core";
import { Conflibot } from "./conflibot";

new Conflibot().run().catch((error) => {
  core.setFailed(error instanceof Error ? error : String(error));
});
