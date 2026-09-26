import { API_HEALTH_PATH, PROJECT_NAME } from "./lib";

export default function Home(): React.JSX.Element {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>{PROJECT_NAME}</h1>
      <p>API health: {API_HEALTH_PATH}</p>
    </main>
  );
}
