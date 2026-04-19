import { Nav } from "@/components/Nav";
import { prisma } from "@/lib/prisma";
import { getConfig } from "@/lib/config";
import { ConfigForms } from "./ConfigForms";

export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const [bulkmedyaKey, rapidApiKey, testAccounts, serviceCount] = await Promise.all([
    getConfig<string>("bulkmedya_api_key"),
    getConfig<string>("rapidapi_key"),
    prisma.testAccount.findMany({ orderBy: [{ platform: "asc" }, { username: "asc" }] }),
    prisma.service.count(),
  ]);

  return (
    <>
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        <h1 className="brand text-3xl">Config</h1>

        <ConfigForms
          initialBulkmedyaSet={Boolean(bulkmedyaKey)}
          initialRapidApiSet={Boolean(rapidApiKey)}
          testAccounts={testAccounts.map((a) => ({
            id: a.id,
            platform: a.platform,
            username: a.username,
            userId: a.userId,
            active: a.active,
          }))}
          serviceCount={serviceCount}
        />
      </main>
    </>
  );
}
