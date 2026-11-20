import { handleModel } from "@/server/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { path } = await params;
  return handleModel(req, path);
}

export { handle as GET, handle as HEAD };
