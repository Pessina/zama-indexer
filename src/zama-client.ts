import { ZamaClient } from "./utils/zama";
import { config } from "./config";

export const zama = new ZamaClient({
  privateKey: config.privateKey,
  rpc: config.rpcUrl,
});
