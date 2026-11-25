import { AuthGuard } from "@/components/common/AuthGuard";
import CosmosPage from "@/components/features/cosmos/CosmosPage";

/** Vũ trụ tri thức — Echo Neural Cosmos. Deep links: ?word=, ?grammar=, ?source=KIND:id, ?focus=. */
export default function KnowledgeUniverseRoute() {
  return (
    <AuthGuard>
      <div className="h-full">
        <CosmosPage />
      </div>
    </AuthGuard>
  );
}
