import { useEffect } from "react";
import { useNavigate } from "react-router";
import { SSO_RETURN_KEY } from "../navigation";
import { useShell } from "../shell";
import { PageLoading } from "./PageStates";

/** `/` opens the projects, or the page that started a single sign-on. */
export default function HomePage() {
  const { signInDestination } = useShell();
  const navigate = useNavigate();
  useEffect(() => {
    sessionStorage.removeItem(SSO_RETURN_KEY);
    void navigate(signInDestination || "/projects", { replace: true });
  }, [navigate, signInDestination]);
  return <PageLoading />;
}
