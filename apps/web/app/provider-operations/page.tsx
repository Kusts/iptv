"use client";

import { ProviderOperations } from "../../components/ProviderOperations";
import { Shell } from "../../components/Shell";

export default function ProviderOperationsPage(): React.JSX.Element {
  return (
    <Shell>
      <h1>Operações de Provider</h1>
      <ProviderOperations />
    </Shell>
  );
}