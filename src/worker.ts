import app from "./app";
import { AuthSession } from "./authSession.do";
import { scheduled } from "./scheduled";

const handler: ExportedHandler<Env> = {
  fetch: app.fetch.bind(app),
  scheduled
};

export { AuthSession };
export default handler;
