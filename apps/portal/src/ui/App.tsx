import { useEffect, useState } from "react";
import { serverUrl } from "./config";
import { Inbox } from "./Inbox";
import { NotBuilt } from "./NotBuilt";
import { parseRoute, SECTIONS, sectionFor } from "./route";
import { StubsPanel } from "./StubsPanel";

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         color: #1a1d21; background: #f6f7f8; }
  .layout { display: flex; min-height: 100vh; }
  nav { width: 230px; flex-shrink: 0; background: #14181d; color: #cfd6dd; padding: 16px 0; }
  nav .brand { font-weight: 700; color: #fff; padding: 8px 20px 16px; font-size: 15px; letter-spacing: 0.02em; }
  nav a { display: block; padding: 8px 20px; color: #cfd6dd; text-decoration: none; font-size: 14px; }
  nav a:hover { background: #1e242b; color: #fff; }
  nav a.active { background: #263039; color: #fff; border-left: 3px solid #4da3ff; padding-left: 17px; }
  main { flex: 1; padding: 28px 36px; max-width: 900px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 18px 0 8px; }
  .muted { color: #6b7480; font-size: 13px; }
  .error-text { color: #b3261e; font-size: 13px; }
  .empty-state { border: 1px dashed #c3cad2; border-radius: 8px; padding: 28px; text-align: center;
                 color: #6b7480; margin-top: 16px; background: #fff; }
  .stub-card, .notbuilt-panel { border: 1px dashed #d99a06; border-radius: 8px; background: #fffaf0;
                                padding: 14px 16px; margin-top: 14px; }
  .stub-card-badge { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase;
                     letter-spacing: 0.06em; color: #8a6100; background: #ffe9b3; border-radius: 4px;
                     padding: 2px 8px; margin-bottom: 8px; }
  .stub-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
             color: #513e00; background: #fff2cf; border-radius: 4px; padding: 1px 6px; }
  .stub-reason { display: block; font-size: 13px; color: #5c554a; margin: 6px 0 0; }
  .stub-list { list-style: none; padding: 0; margin: 10px 0 0; }
  .stub-list li { padding: 8px 0; border-top: 1px solid #f0e4c3; }
  .stub-list li:first-child { border-top: none; }
  .invocations { font-size: 12px; color: #8a6100; margin-left: 8px; }
  .census-group { background: #fff; border: 1px solid #e2e6ea; border-radius: 8px; padding: 4px 16px 12px;
                  margin-top: 14px; }
  .request-card { background: #fff; border: 1px solid #e2e6ea; border-radius: 8px; padding: 14px 16px;
                  margin-top: 14px; }
  .request-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7480; }
  .request-summary { font-size: 15px; font-weight: 600; margin: 6px 0; }
  .request-meta { display: flex; gap: 14px; font-size: 12.5px; color: #6b7480; flex-wrap: wrap; }
  .request-actions { margin-top: 10px; display: flex; gap: 8px; }
  button { font: inherit; font-size: 13px; border-radius: 6px; padding: 6px 14px; cursor: pointer;
           border: 1px solid transparent; }
  button.approve { background: #1668c7; color: #fff; }
  button.deny { background: #fff; color: #b3261e; border-color: #d8b4b1; }
`;

function useHashRoute(): string {
  const [route, setRoute] = useState<string>(() =>
    parseRoute(typeof location !== "undefined" ? location.hash : ""),
  );
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

function Home() {
  return (
    <section>
      <h1>lithis</h1>
      <p>
        Open-source AI tools for companies: unified context, resident agents, process
        orchestration, and the operational scaffolding around them. This portal is the admin
        surface over the lithis server at <code>{serverUrl()}</code>.
      </p>
      <p className="muted">
        This is the skeleton build. Interfaces and contracts are real; most capabilities behind
        these pages are registered stubs that fail loudly instead of faking data. See{" "}
        <a href="#/stubs">What&apos;s real yet</a> for the live census, or open the{" "}
        <a href="#/inbox">Inbox</a> to see the human-approval surface.
      </p>
    </section>
  );
}

export function App() {
  const route = useHashRoute();
  const section = sectionFor(route);

  let page;
  switch (section.id) {
    case "home":
      page = <Home />;
      break;
    case "inbox":
      page = <Inbox />;
      break;
    case "stubs":
      page = <StubsPanel />;
      break;
    default:
      page = <NotBuilt section={section} />;
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="layout">
        <nav>
          <div className="brand">lithis portal</div>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#/${s.id}`} className={s.id === section.id ? "active" : ""}>
              {s.label}
            </a>
          ))}
        </nav>
        <main>{page}</main>
      </div>
    </>
  );
}
