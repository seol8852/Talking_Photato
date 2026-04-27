import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./App.css";
import App from "./App.jsx";
import AuthPage from "./AuthPage.jsx";
import { supabase } from "./supabaseClient.js";

// ── 카카오 SDK 동적 로드 (env 변수 사용 가능) ──
const loadKakaoSDK = () => {
  return new Promise((resolve) => {
    if (window.kakao) { resolve(); return; }
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${import.meta.env.VITE_KAKAO_MAP_KEY}&libraries=services&autoload=false`;
    script.onload = resolve;
    document.head.appendChild(script);
  });
};

loadKakaoSDK(); // 앱 시작 즉시 로드 시작

const Root = () => {
  const [user, setUser] = useState(null);
  const [couple, setCouple] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 앱 시작 시 기존 세션 확인
    const initAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();

      if (session?.user) {
        // 커플 연결 여부 확인
        const { data: coupleData } = await supabase
          .from("couples")
          .select("*")
          .or(`user_a.eq.${session.user.id},user_b.eq.${session.user.id}`)
          .maybeSingle();

        setUser(session.user);
        setCouple(coupleData || null);
      }
      setLoading(false);
    };

    initAuth();

    // 로그인/로그아웃 상태 변화 감지
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUser(null);
        setCouple(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleAuthComplete = (user, couple) => {
    setUser(user);
    setCouple(couple);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setCouple(null);
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", backgroundColor: "#0A0A0F", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, border: "2px solid rgba(255,107,107,0.3)", borderTopColor: "#FF6B6B", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)" }}>SpotLog</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // 로그인 안 됐거나 커플 미연결 → AuthPage
  if (!user || !couple) {
    return <AuthPage onAuthComplete={handleAuthComplete} />;
  }

  // 로그인 + 커플 연결 완료 → 메인 앱
  return <App user={user} couple={couple} onLogout={handleLogout} />;
};

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
