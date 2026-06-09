import React, { useState } from "react";
import { Heart, Mail, Lock, KeyRound, Loader2, ArrowLeft, Send } from "lucide-react";
import { supabase } from "./supabaseClient";

// ── 랜덤 초대 코드 생성 (6자리 영숫자) ──
const generateInviteCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const AuthPage = ({ onAuthComplete }) => {
  // step: "landing" | "login" | "signup" | "invite-choice" | "create-couple" | "join-couple"
  const [step, setStep] = useState("landing");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [myInviteCode, setMyInviteCode] = useState(null);

  const clearError = () => setError(null);

  // ── 로그인 ──
  const handleLogin = async () => {
    if (!email || !password) { setError("이메일과 비밀번호를 입력해주세요."); return; }
    setLoading(true); clearError();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setError(`로그인 실패: ${error.message}`); setLoading(false); return; }

    // 커플 연결 여부 확인
    const { data: couple } = await supabase
      .from("couples")
      .select("*")
      .or(`user_a.eq.${data.user.id},user_b.eq.${data.user.id}`)
      .maybeSingle();

    setLoading(false);
    if (couple) {
      onAuthComplete(data.user, couple);
    } else {
      setStep("invite-choice");
    }
  };

  // ── 회원가입 ──
  const handleSignup = async () => {
    if (!email || !password) { setError("이메일과 비밀번호를 입력해주세요."); return; }
    if (password.length < 6) { setError("비밀번호는 6자 이상이어야 해요."); return; }
    setLoading(true); clearError();
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) { setError(`회원가입 실패: ${error.message}`); setLoading(false); return; }
    setLoading(false);
    setStep("invite-choice");
  };

  // ── 커플 코드 생성 ──
  const handleCreateCouple = async () => {
    setLoading(true); clearError();
    const { data: { user } } = await supabase.auth.getUser();
    const code = generateInviteCode();

    const { data, error } = await supabase
      .from("couples")
      .insert({ invite_code: code, user_a: user.id })
      .select()
      .single();

    setLoading(false);
    if (error) { setError("코드 생성에 실패했어요."); return; }
    setMyInviteCode(code);
  };

  // ── 초대 코드로 커플 연결 ──
  const handleJoinCouple = async () => {
    if (!inviteCode.trim()) { setError("초대 코드를 입력해주세요."); return; }
    setLoading(true); clearError();
    const { data: { user } } = await supabase.auth.getUser();

    // 코드로 커플 찾기
    const { data: couple, error: findError } = await supabase
      .from("couples")
      .select("*")
      .eq("invite_code", inviteCode.trim().toUpperCase())
      .maybeSingle();

    if (findError || !couple) { setError("유효하지 않은 초대 코드예요."); setLoading(false); return; }
    if (couple.user_b) { setError("이미 사용된 초대 코드예요."); setLoading(false); return; }
    if (couple.user_a === user.id) { setError("본인이 만든 코드예요. 상대방에게 공유해주세요."); setLoading(false); return; }

    // user_b 자리에 현재 유저 연결
    const { data: updated, error: updateError } = await supabase
      .from("couples")
      .update({ user_b: user.id })
      .eq("id", couple.id)
      .select()
      .single();

    setLoading(false);
    if (updateError) { setError("연결에 실패했어요."); return; }
    const { data: { user: freshUser } } = await supabase.auth.getUser();
    onAuthComplete(freshUser, updated);
  };

  // ── 이미 코드 생성한 후 상대방이 입력 완료 대기 → 폴링 ──
  const handleWaitForPartner = async () => {
    setLoading(true);
    const poll = setInterval(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: couple } = await supabase
        .from("couples")
        .select("*")
        .eq("user_a", user.id)
        .not("user_b", "is", null)
        .maybeSingle();

      if (couple) {
        clearInterval(poll);
        setLoading(false);
        onAuthComplete(user, couple);
      }
    }, 2000);
    // 3분 후 포기
    setTimeout(() => { clearInterval(poll); setLoading(false); setError("상대방이 아직 코드를 입력하지 않았어요. 나중에 다시 확인해주세요."); }, 180000);
  };

  // ── 입력 스타일 ──
  const inputStyle = {
    width: "100%", padding: "12px 16px", borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "white", fontSize: 14, outline: "none",
    boxSizing: "border-box",
  };

  const btnPrimary = {
    width: "100%", padding: 14, borderRadius: 12,
    backgroundColor: "#FF6B6B", color: "white",
    fontSize: 14, fontWeight: 500, border: "none", cursor: "pointer",
  };

  const btnSecondary = {
    width: "100%", padding: 14, borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)",
    fontSize: 14, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
  };

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, colorScheme: "dark" }}>

      {/* 배경 glow */}
      <div style={{ position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", width: 500, height: 300, background: "radial-gradient(ellipse, rgba(255,107,107,0.08) 0%, transparent 70%)", filter: "blur(40px)", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: 380, position: "relative", zIndex: 1 }}>

        {/* 로고 */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
            <Heart size={18} fill="#FF6B6B" color="#FF6B6B" />
            <span style={{ fontSize: 20, fontWeight: 500, letterSpacing: "0.14em", color: "#FF6B6B", textTransform: "uppercase" }}>SpotLog</span>
          </div>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.3)" }}>우리만의 지도를 함께 채워가요</p>
        </div>

        {/* ── LANDING ── */}
        {step === "landing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => setStep("login")} style={btnPrimary}>로그인</button>
            <button onClick={() => setStep("signup")} style={btnSecondary}>처음이에요, 회원가입</button>
          </div>
        )}

        {/* ── LOGIN ── */}
        {step === "login" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => { setStep("landing"); clearError(); }} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: 0, marginBottom: 8 }}>
              <ArrowLeft size={14} /> 뒤로
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 500, color: "white", marginBottom: 8 }}>로그인</h2>
            <div style={{ position: "relative" }}>
              <Mail size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
              <input style={{ ...inputStyle, paddingLeft: 40 }} type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            <div style={{ position: "relative" }}>
              <Lock size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
              <input style={{ ...inputStyle, paddingLeft: 40 }} type="password" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            {error && <p style={{ fontSize: 12, color: "#FF6B6B", textAlign: "center" }}>{error}</p>}
            <button onClick={handleLogin} disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.6 : 1 }}>
              {loading ? <Loader2 size={16} className="animate-spin" style={{ margin: "0 auto" }} /> : "로그인"}
            </button>
            <button onClick={() => { setStep("signup"); clearError(); }} style={{ ...btnSecondary, marginTop: 4 }}>계정이 없으신가요? 회원가입</button>
          </div>
        )}

        {/* ── SIGNUP ── */}
        {step === "signup" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => { setStep("landing"); clearError(); }} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: 0, marginBottom: 8 }}>
              <ArrowLeft size={14} /> 뒤로
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 500, color: "white", marginBottom: 8 }}>회원가입</h2>
            <div style={{ position: "relative" }}>
              <Mail size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
              <input style={{ ...inputStyle, paddingLeft: 40 }} type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div style={{ position: "relative" }}>
              <Lock size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
              <input style={{ ...inputStyle, paddingLeft: 40 }} type="password" placeholder="비밀번호 (6자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p style={{ fontSize: 12, color: "#FF6B6B", textAlign: "center" }}>{error}</p>}
            <button onClick={handleSignup} disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.6 : 1 }}>
              {loading ? <Loader2 size={16} className="animate-spin" style={{ margin: "0 auto" }} /> : "회원가입"}
            </button>
            <button onClick={() => { setStep("login"); clearError(); }} style={{ ...btnSecondary, marginTop: 4 }}>이미 계정이 있어요</button>
          </div>
        )}

        {/* ── INVITE CHOICE ── */}
        {step === "invite-choice" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 500, color: "white", marginBottom: 4 }}>커플 연결</h2>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 12 }}>상대방과 초대 코드로 연결해야 함께 지도를 꾸밀 수 있어요</p>

            <button onClick={() => { setStep("create-couple"); clearError(); }}
              style={{ ...btnPrimary, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <Send size={16} /> 초대 코드 만들기
            </button>
            <button onClick={() => { setStep("join-couple"); clearError(); }}
              style={{ ...btnSecondary, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <KeyRound size={16} /> 초대 코드 입력하기
            </button>
          </div>
        )}

        {/* ── CREATE COUPLE ── */}
        {step === "create-couple" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => { setStep("invite-choice"); clearError(); setMyInviteCode(null); }}
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: 0, marginBottom: 8 }}>
              <ArrowLeft size={14} /> 뒤로
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 500, color: "white", marginBottom: 4 }}>초대 코드 만들기</h2>

            {!myInviteCode ? (
              <>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>
                  코드를 생성하고 상대방에게 공유해주세요
                </p>
                {error && <p style={{ fontSize: 12, color: "#FF6B6B", textAlign: "center" }}>{error}</p>}
                <button onClick={handleCreateCouple} disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.6 : 1 }}>
                  {loading ? <Loader2 size={16} className="animate-spin" style={{ margin: "0 auto" }} /> : "코드 생성하기"}
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>상대방에게 아래 코드를 공유해주세요</p>
                <div style={{ padding: "20px", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 16, textAlign: "center" }}>
                  <p style={{ fontSize: 11, color: "rgba(255,107,107,0.6)", marginBottom: 8, letterSpacing: "0.08em" }}>INVITE CODE</p>
                  <p style={{ fontSize: 32, fontWeight: 500, color: "#FF6B6B", letterSpacing: "0.2em" }}>{myInviteCode}</p>
                </div>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>상대방이 코드를 입력하면 자동으로 연결돼요</p>
                {error && <p style={{ fontSize: 12, color: "#FF6B6B", textAlign: "center" }}>{error}</p>}
                <button onClick={handleWaitForPartner} disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.6 : 1 }}>
                  {loading
                    ? <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Loader2 size={16} className="animate-spin" /> 상대방 연결 대기 중...</span>
                    : "상대방 연결 확인하기"}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── JOIN COUPLE ── */}
        {step === "join-couple" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => { setStep("invite-choice"); clearError(); }}
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: 0, marginBottom: 8 }}>
              <ArrowLeft size={14} /> 뒤로
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 500, color: "white", marginBottom: 4 }}>초대 코드 입력</h2>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>상대방에게 받은 6자리 코드를 입력해주세요</p>
            <div style={{ position: "relative" }}>
              <KeyRound size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
              <input
                style={{ ...inputStyle, paddingLeft: 40, textTransform: "uppercase", letterSpacing: "0.15em", fontSize: 18, textAlign: "center" }}
                type="text" placeholder="XXXXXX" maxLength={6}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleJoinCouple()}
              />
            </div>
            {error && <p style={{ fontSize: 12, color: "#FF6B6B", textAlign: "center" }}>{error}</p>}
            <button onClick={handleJoinCouple} disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.6 : 1 }}>
              {loading ? <Loader2 size={16} className="animate-spin" style={{ margin: "0 auto" }} /> : "연결하기"}
            </button>
          </div>
        )}

      </div>

      <style>{`
        input::placeholder { color: rgba(255,255,255,0.25); }
        input:focus { border-color: rgba(255,107,107,0.4) !important; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
};

export default AuthPage;