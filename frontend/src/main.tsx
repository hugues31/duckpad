import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { pageRoutes } from "./navigation";
import "./styles.css";
import "./settings.css";
const router = createBrowserRouter([{ Component: App, children: pageRoutes }]);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
