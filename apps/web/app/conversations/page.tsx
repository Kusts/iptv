"use client";

import { Shell } from "../../components/Shell";
import { ConversationsPanel } from "../../components/ConversationsPanel";

export default function ConversationsPage(): React.JSX.Element {
  return (
    <Shell>
      <h1>Conversas</h1>
      <ConversationsPanel />
    </Shell>
  );
}
