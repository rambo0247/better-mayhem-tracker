import { Outlet, useLocation } from "react-router-dom";
import Header, { TitleBar } from "./Header";
import RecoveryBanner from "./RecoveryBanner";
import ActivityToast from "./ActivityToast";

export default function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="flex h-full w-full bg-lol-deep">
      <Header />
      <div className="app-stage relative flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <RecoveryBanner />
        {/* Pages cap their own width; on a window wider than that they sit in
            the middle rather than against the left edge */}
        <main className="scrollbar-edge relative flex-1 overflow-y-auto px-8 pb-10 pt-2">
          {/* Keyed by path so each page eases in as it's opened */}
          <div key={pathname} className="view-in [&>*]:mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
      <ActivityToast />
    </div>
  );
}
