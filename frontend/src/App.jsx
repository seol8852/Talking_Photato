import React, { useState, useEffect, useRef } from "react";
import { Menu, X, Plus, MapPin, Heart, Upload, Loader2, Trash2, ArrowLeft, Check, AlertCircle, LogOut } from "lucide-react";
import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import * as exifr from "exifr";
import { supabase } from "./supabaseClient";

const GEO_URL =
  "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-topo.json";

const SIDO_PREFIX = {
  "11": "서울", "21": "부산", "22": "대구", "23": "인천",
  "24": "광주", "25": "대전", "26": "울산", "29": "세종",
  "31": "경기", "32": "강원", "33": "충북", "34": "충남",
  "35": "전북", "36": "전남", "37": "경북", "38": "경남", "39": "제주",
};

const DUPLICATE_NAMES = new Set([
  "중구", "남구", "북구", "동구", "서구",
  "강서구", "강동구", "강남구", "강북구", "수성구", "달서구",
]);

const buildKeyFromCode = (name, code) => {
  if (!name) return "";
  if (DUPLICATE_NAMES.has(name) && code) {
    const prefix = SIDO_PREFIX[String(code).slice(0, 2)];
    if (prefix) return `${prefix} ${name}`;
  }
  return name;
};

const buildKeyFromKakao = (depth1, depth2) => {
  if (!depth2) return null;
  if (DUPLICATE_NAMES.has(depth2)) {
    const cityPrefix = depth1
      .replace("특별시", "").replace("광역시", "").replace("특별자치시", "")
      .replace("특별자치도", "").replace("도", "").trim();
    return `${cityPrefix} ${depth2}`;
  }
  return depth2;
};

const formatDate = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

const getDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const extractPointsFromFiles = async (files) => {
  const results = [];
  for (const file of files) {
    try {
      const exif = await exifr.parse(file, {
        gps: true, tiff: true, exif: true,
        pick: ["latitude", "longitude", "DateTimeOriginal"],
      });
      if (exif?.latitude && exif?.longitude) {
        results.push({
          lat: exif.latitude, lng: exif.longitude,
          time: exif.DateTimeOriginal || null,
          fileName: file.name,
        });
      }
    } catch (err) {
      console.warn(`EXIF 파싱 실패: ${file.name}`, err);
    }
  }
  results.sort((a, b) => {
    if (!a.time || !b.time) return 0;
    return new Date(a.time) - new Date(b.time);
  });
  return results;
};

const groupPointsByDate = (points) => {
  const groups = {};
  for (const point of points) {
    const key = point.time ? getDateKey(point.time) : "unknown";
    if (!groups[key]) groups[key] = { dateKey: key, date: point.time, points: [] };
    groups[key].points.push(point);
  }
  return Object.values(groups).sort((a, b) => {
    if (a.dateKey === "unknown") return 1;
    if (b.dateKey === "unknown") return -1;
    return a.dateKey.localeCompare(b.dateKey);
  });
};

const getRegionFromCoords = (lat, lng) => {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services) { resolve(null); return; }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.coord2RegionCode(lng, lat, (result, status) => {
      if (status !== window.kakao.maps.services.Status.OK) { resolve(null); return; }
      const region = result.find((r) => r.region_type === "B") || result.find((r) => r.region_type === "H");
      if (!region) { resolve(null); return; }
      resolve(buildKeyFromKakao(region.region_1depth_name, region.region_2depth_name));
    });
  });
};

const getDominantRegion = async (points) => {
  const counts = {};
  for (const p of points) {
    const r = await getRegionFromCoords(p.lat, p.lng);
    if (r) counts[r] = (counts[r] || 0) + 1;
  }
  if (!Object.keys(counts).length) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

const waitForKakao = (timeout = 5000) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (Date.now() - start > timeout) { clearInterval(check); resolve(false); return; }
      if (window.kakao) { clearInterval(check); window.kakao.maps.load(() => resolve(true)); }
    }, 100);
  });
};

// ── 카카오 상세 지도 ──
const KakaoDetailMap = ({ data, onBack }) => {
  const mapContainer = useRef(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    let attempts = 0;
    const checkKakao = setInterval(() => {
      attempts++;
      if (attempts > 50) { clearInterval(checkKakao); setErrorMsg("카카오맵을 불러오지 못했어요."); return; }
      if (!window.kakao) return;
      clearInterval(checkKakao);
      window.kakao.maps.load(() => {
        if (!mapContainer.current) return;
        try {
          const { kakao } = window;
          const center = new kakao.maps.LatLng(data.points[0].lat, data.points[0].lng);
          const map = new kakao.maps.Map(mapContainer.current, { center, level: 4 });
          map.relayout();
          if (data.points.length > 1) {
            const bounds = new kakao.maps.LatLngBounds();
            data.points.forEach((p) => bounds.extend(new kakao.maps.LatLng(p.lat, p.lng)));
            map.setBounds(bounds, 80);
          }
          const linePath = data.points.map((p) => new kakao.maps.LatLng(p.lat, p.lng));
          new kakao.maps.Polyline({ path: linePath, strokeWeight: 5, strokeColor: "#FF6B6B", strokeOpacity: 0.85, strokeStyle: "solid" }).setMap(map);
          linePath.forEach((pos, idx) => {
            const isFirst = idx === 0, isLast = idx === linePath.length - 1;
            const label = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `${idx + 1}`;
            const content = `<div style="background:#FF6B6B;color:white;padding:5px 11px;border-radius:20px;font-size:12px;font-weight:600;border:2px solid rgba(255,255,255,0.9);box-shadow:0 3px 10px rgba(0,0,0,0.35);white-space:nowrap;">${label}</div>`;
            new kakao.maps.CustomOverlay({ content, position: pos, yAnchor: 2.6 }).setMap(map);
          });
          setIsMapReady(true);
        } catch (err) { setErrorMsg("지도를 렌더링하는 중 오류가 발생했어요."); }
      });
    }, 100);
    return () => clearInterval(checkKakao);
  }, [data]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Spot Detail</p>
          <h3 style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.regionName} 동선</h3>
        </div>
        <div style={{ padding: "4px 12px", backgroundColor: "rgba(255,107,107,0.12)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 20, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#FF6B6B" }}>📍 {data.points.length}곳</span>
        </div>
      </div>
      {!isMapReady && !errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10 }}>
          <Loader2 className="animate-spin" size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>카카오맵 불러오는 중...</p>
        </div>
      )}
      {errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10, padding: "0 32px" }}>
          <AlertCircle size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 14, color: "white", textAlign: "center", whiteSpace: "pre-line" }}>{errorMsg}</p>
        </div>
      )}
      <div ref={mapContainer} style={{ flex: 1, width: "100%", minHeight: 0 }} />
      {isMapReady && data.points.length > 0 && (
        <div style={{ padding: "12px 16px", backgroundColor: "#0D0D16", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 8, overflowX: "auto", flexShrink: 0 }}>
          {data.points.map((p, idx) => (
            <div key={idx} style={{ flexShrink: 0, padding: "8px 12px", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, minWidth: 90 }}>
              <p style={{ fontSize: 10, color: "#FF6B6B", marginBottom: 3 }}>{idx === 0 ? "🚀 출발" : idx === data.points.length - 1 ? "🏁 도착" : `📍 ${idx + 1}`}</p>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</p>
              {p.time && <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>{new Date(p.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── 날짜별 그룹 카드 ──
const DateGroupCard = ({ group, index }) => (
  <div style={{ padding: "12px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 20, height: 20, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 10, color: "white", fontWeight: 600 }}>{index + 1}</span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 500, color: "white" }}>{group.date ? formatDate(group.date) : "날짜 미상"}</span>
      </div>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>📍 {group.points.length}장</span>
    </div>
    {group.regionName && <p style={{ fontSize: 12, color: "#FF6B6B", marginLeft: 28 }}>대표 지역: {group.regionName}</p>}
    {!group.regionName && group.analyzing && (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 28 }}>
        <Loader2 size={11} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>지역 분석 중...</span>
      </div>
    )}
  </div>
);

// ── 메인 앱 ──
const SpotLog = ({ user, couple, onLogout }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [uploadStep, setUploadStep] = useState(0);
  const [previewFile, setPreviewFile] = useState(null);
  const [pendingGroups, setPendingGroups] = useState([]);
  const [viewDetail, setViewDetail] = useState(null);
  const [filterYear, setFilterYear] = useState("전체");

  // ── Supabase에서 불러온 방문 기록 ──
  const [visitedLogs, setVisitedLogs] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);

  // ── DB에서 방문 기록 불러오기 ──
  const fetchVisits = async () => {
    const { data, error } = await supabase
      .from("visits")
      .select("*")
      .eq("couple_id", couple.id)
      .order("created_at", { ascending: false });

    if (error) { console.error("방문 기록 불러오기 실패:", error); return; }

    setVisitedLogs(data.map((row) => ({
      id: row.id,
      regionName: row.region_name,
      date: row.date,
      points: row.points,
    })));
    setDbLoading(false);
  };

  // ── 실시간 구독 (상대방이 추가/삭제하면 자동 반영) ──
  useEffect(() => {
    fetchVisits();

    const channel = supabase
      .channel(`visits-${couple.id}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "visits",
        filter: `couple_id=eq.${couple.id}`,
      }, () => {
        fetchVisits(); // 변경 감지 시 전체 재조회
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [couple.id]);

  const getGeoKey = (geo) => buildKeyFromCode(geo.properties.name, geo.properties.code);
  const visitedNames = visitedLogs.map((l) => l.regionName);
  const years = ["전체", ...new Set(visitedLogs.map((l) => l.date.split(".")[0]))].reverse();
  const filteredLogs = filterYear === "전체" ? visitedLogs : visitedLogs.filter((l) => l.date.startsWith(filterYear));

  // ── 파일 업로드 & EXIF 파싱 ──
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setPreviewFile(URL.createObjectURL(files[0]));
    setUploadStep(1);
    try {
      const points = await extractPointsFromFiles(files);
      if (points.length === 0) { setUploadStep(3); return; }
      const groups = groupPointsByDate(points);
      const initialGroups = groups.map((g) => ({ ...g, regionName: null, analyzing: true }));
      setPendingGroups(initialGroups);
      setUploadStep(2);
      const kakaoReady = await waitForKakao(3000);
      if (kakaoReady) {
        for (let i = 0; i < groups.length; i++) {
          const region = await getDominantRegion(groups[i].points);
          setPendingGroups((prev) =>
            prev.map((g, idx) => idx === i ? { ...g, regionName: region || selectedRegion || "알 수 없는 지역", analyzing: false } : g)
          );
        }
      } else {
        setPendingGroups((prev) => prev.map((g) => ({ ...g, regionName: selectedRegion || "알 수 없는 지역", analyzing: false })));
      }
    } catch (err) {
      console.error("EXIF 처리 오류:", err);
      setUploadStep(3);
    }
  };

  // ── Supabase에 저장 ──
  const handleSave = async () => {
    const rows = pendingGroups.map((group) => ({
      couple_id: couple.id,
      region_name: group.regionName || selectedRegion || "알 수 없는 지역",
      date: group.date ? formatDate(group.date) : formatDate(new Date()),
      points: group.points,
    }));

    const { error } = await supabase.from("visits").insert(rows);
    if (error) { console.error("저장 실패:", error); alert("저장에 실패했어요."); return; }
    closeModal();
  };

  // ── Supabase에서 삭제 ──
  const deleteLog = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm("이 구역의 기록을 삭제할까요?")) return;
    const { error } = await supabase.from("visits").delete().eq("id", id);
    if (error) { console.error("삭제 실패:", error); alert("삭제에 실패했어요."); }
    setSelectedRegion(null);
  };

  const closeModal = () => {
    setModalOpen(false);
    setUploadStep(0);
    setPreviewFile(null);
    setPendingGroups([]);
  };

  const isAnalyzing = pendingGroups.some((g) => g.analyzing);

  return (
    <div className="w-full max-w-screen-xl mx-auto h-screen flex flex-col overflow-hidden relative" style={{ backgroundColor: "#0A0A0F", colorScheme: "dark" }}>
      {viewDetail && <KakaoDetailMap data={viewDetail} onBack={() => setViewDetail(null)} />}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 pointer-events-none z-0" style={{ width: 600, height: 240, background: "radial-gradient(ellipse, rgba(255,107,107,0.07) 0%, transparent 70%)", filter: "blur(40px)" }} />

      {/* HEADER */}
      <header className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-screen-xl z-50 flex items-center justify-between px-5 py-4" style={{ background: "linear-gradient(to bottom, #0A0A0F 60%, transparent)" }}>
        <button onClick={() => setDrawerOpen(true)} className="w-9 h-9 flex items-center justify-center rounded-xl" style={{ backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2">
          <Heart size={14} fill="#FF6B6B" color="#FF6B6B" />
          <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: "0.14em", color: "#FF6B6B", textTransform: "uppercase" }}>SpotLog</span>
        </div>
        <button onClick={() => setModalOpen(true)} className="w-9 h-9 flex items-center justify-center rounded-xl" style={{ backgroundColor: "#FF6B6B", color: "white", border: "none", cursor: "pointer", boxShadow: "0 4px 16px rgba(255,107,107,0.3)" }}>
          <Plus size={18} />
        </button>
      </header>

      {/* MAIN */}
      <main className="flex-1 pt-[72px] pb-4 px-4 flex flex-col gap-3 relative z-10 overflow-hidden">

        {/* 통계 바 */}
        <div className="flex justify-between items-center px-4 py-3.5 rounded-2xl" style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Our Footprints</p>
            <div className="flex items-baseline gap-1.5">
              <span style={{ fontSize: 22, fontWeight: 500, color: "#FF6B6B" }}>{visitedLogs.length}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>/ 250 시군구</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 6 }}>정복률 {((visitedLogs.length / 250) * 100).toFixed(1)}%</p>
            <div className="rounded-full overflow-hidden" style={{ width: 80, height: 3, backgroundColor: "rgba(255,255,255,0.08)" }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max((visitedLogs.length / 250) * 100, 0.5)}%`, backgroundColor: "#FF6B6B" }} />
            </div>
          </div>
        </div>

        {/* 지도 */}
        <div className="flex-1 rounded-3xl overflow-hidden" style={{ backgroundColor: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", minHeight: 280 }}>
          {dbLoading ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Loader2 className="animate-spin" size={28} style={{ color: "#FF6B6B" }} />
            </div>
          ) : (
            <ComposableMap projection="geoMercator" projectionConfig={{ scale: 4500, center: [127.9, 36.2] }} style={{ width: "100%", height: "100%" }}>
              <ZoomableGroup zoom={1}>
                <Geographies geography={GEO_URL}>
                  {({ geographies }) =>
                    geographies.map((geo) => {
                      const key = getGeoKey(geo);
                      const visited = visitedNames.includes(key);
                      const selected = selectedRegion === key;
                      return (
                        <Geography key={geo.rsmKey} geography={geo} onClick={() => setSelectedRegion(key)}
                          style={{
                            default: { fill: selected ? "#FF6B6B" : visited ? "rgba(255,107,107,0.28)" : "rgba(255,255,255,0.04)", stroke: selected ? "rgba(255,255,255,0.4)" : visited ? "rgba(255,107,107,0.5)" : "rgba(255,255,255,0.18)", strokeWidth: 0.5, outline: "none" },
                            hover: { fill: visited ? "rgba(255,107,107,0.45)" : "rgba(255,107,107,0.2)", cursor: "pointer", outline: "none" },
                            pressed: { fill: "#FF6B6B", outline: "none" },
                          }}
                        />
                      );
                    })
                  }
                </Geographies>
              </ZoomableGroup>
            </ComposableMap>
          )}
        </div>

        {/* 하단 선택 바 */}
        <div className="shrink-0">
          {selectedRegion ? (
            <div className="flex items-center gap-3 px-4 py-3.5 rounded-2xl" style={{ backgroundColor: "#16161F", border: "1px solid rgba(255,107,107,0.2)" }}>
              <MapPin size={16} style={{ color: "#FF6B6B", flexShrink: 0 }} />
              <div className="flex-1" style={{ minWidth: 0 }}>
                <p style={{ fontSize: 10, color: "rgba(255,107,107,0.6)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                  {visitedNames.includes(selectedRegion) ? "Visited ✓" : "Selected Region"}
                </p>
                <p style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedRegion}</p>
              </div>
              {visitedNames.includes(selectedRegion) ? (
                <button onClick={() => setViewDetail(visitedLogs.find((l) => l.regionName === selectedRegion))} className="rounded-xl"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, cursor: "pointer" }}>
                  동선 보기
                </button>
              ) : (
                <button onClick={() => setModalOpen(true)} className="rounded-xl"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "white", backgroundColor: "#FF6B6B", border: "none", flexShrink: 0, cursor: "pointer" }}>
                  기록하기
                </button>
              )}
            </div>
          ) : (
            <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", fontStyle: "italic", padding: "16px 0" }}>
              지도를 클릭하여 새로운 추억을 정복하세요
            </p>
          )}
        </div>
      </main>

      {/* DRAWER */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[1000] flex">
          <div className="absolute inset-0 backdrop-blur-sm" style={{ backgroundColor: "rgba(0,0,0,0.5)" }} onClick={() => setDrawerOpen(false)} />
          <div className="relative flex flex-col" style={{ width: 280, height: "100%", backgroundColor: "#0D0D16", borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: "#FF6B6B" }}>History</span>
              <button onClick={() => setDrawerOpen(false)} style={{ color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }}><X size={18} /></button>
            </div>

            {/* 유저 정보 + 로그아웃 */}
            <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{user?.email}</p>
              <button onClick={onLogout} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", fontSize: 11, cursor: "pointer" }}>
                <LogOut size={12} /> 로그아웃
              </button>
            </div>

            <div className="flex gap-2 px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              {years.map((y) => (
                <button key={y} onClick={() => setFilterYear(y)} className="rounded-lg"
                  style={{ padding: "6px 12px", fontSize: 11, border: filterYear === y ? "1px solid rgba(255,107,107,0.35)" : "1px solid rgba(255,255,255,0.08)", backgroundColor: filterYear === y ? "rgba(255,107,107,0.1)" : "transparent", color: filterYear === y ? "#FF6B6B" : "rgba(255,255,255,0.35)", cursor: "pointer" }}>
                  {y}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredLogs.map((log) => (
                <div key={log.id} onClick={() => { setViewDetail(log); setDrawerOpen(false); }} className="flex items-center gap-3 rounded-xl cursor-pointer"
                  style={{ padding: "12px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", transition: "border-color 0.2s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,107,107,0.2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)")}
                >
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 3 }}>{log.date}</p>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {log.regionName} · {log.points.length}곳</p>
                  </div>
                  <button onClick={(e) => deleteLog(log.id, e)} style={{ padding: 6, color: "rgba(255,255,255,0.2)", background: "none", border: "none", cursor: "pointer", transition: "color 0.2s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.2)")}
                  ><Trash2 size={14} /></button>
                </div>
              ))}
              {filteredLogs.length === 0 && <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", padding: "40px 0", fontStyle: "italic" }}>기록이 없어요</p>}
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-[2000] flex items-end justify-center">
          <div className="absolute inset-0 backdrop-blur-sm" style={{ backgroundColor: "rgba(0,0,0,0.7)" }} onClick={closeModal} />
          <div className="relative w-full" style={{ maxWidth: 420, backgroundColor: "#0D0D16", border: "1px solid rgba(255,255,255,0.08)", borderBottom: "none", borderRadius: "28px 28px 0 0", padding: "20px 20px 32px" }}>
            <div className="mx-auto mb-5" style={{ width: 36, height: 3, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2 }} />

            {uploadStep === 0 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 20 }}>추억 업로드</h3>
                <label className="flex flex-col items-center gap-3 w-full cursor-pointer rounded-2xl"
                  style={{ padding: "40px 20px", border: "1.5px dashed rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.01)", transition: "all 0.2s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,107,107,0.3)"; e.currentTarget.style.backgroundColor = "rgba(255,107,107,0.02)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.01)"; }}
                >
                  <Upload size={22} style={{ color: "#FF6B6B" }} />
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginBottom: 4 }}>사진을 선택하면 날짜별로 자동 분류됩니다</p>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)" }}>EXIF 위치 데이터로 동선이 생성돼요</p>
                  </div>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)" }}>JPG · HEIC · PNG · 여러 장 선택 가능</p>
                  <input type="file" className="hidden" onChange={handleFileUpload} accept="image/*" multiple />
                </label>
              </>
            )}

            {uploadStep === 1 && (
              <div className="flex flex-col items-center gap-4" style={{ padding: "48px 0" }}>
                <Loader2 className="animate-spin" size={32} style={{ color: "#FF6B6B" }} />
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: "white", marginBottom: 4 }}>위치 데이터 분석 중</p>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>EXIF GPS 정보를 읽고 있어요...</p>
                </div>
              </div>
            )}

            {uploadStep === 2 && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 500, color: "white" }}>{pendingGroups.length}일의 추억 발견</h3>
                  {isAnalyzing && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Loader2 size={13} className="animate-spin" style={{ color: "#FF6B6B" }} />
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>지역 분석 중</span>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, maxHeight: 280, overflowY: "auto" }}>
                  {pendingGroups.map((group, idx) => <DateGroupCard key={idx} group={group} index={idx} />)}
                </div>
                <button onClick={handleSave} disabled={isAnalyzing} className="w-full rounded-xl"
                  style={{ padding: 14, backgroundColor: isAnalyzing ? "rgba(255,107,107,0.4)" : "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", cursor: isAnalyzing ? "not-allowed" : "pointer" }}>
                  {isAnalyzing ? "분석 완료 후 저장 가능" : `${pendingGroups.length}개 기록 저장하기`}
                </button>
              </>
            )}

            {uploadStep === 3 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 16 }}>위치 정보 없음</h3>
                <div className="flex flex-col items-center gap-3 rounded-2xl" style={{ padding: "32px 20px", backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <AlertCircle size={28} style={{ color: "rgba(255,255,255,0.3)" }} />
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>사진에 GPS 정보가 없어요</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>카메라 앱에서 위치 권한을 허용하거나<br />지도에서 구역을 먼저 선택 후 기록해보세요</p>
                  </div>
                </div>
                <button onClick={() => setUploadStep(0)} className="rounded-xl" style={{ width: "100%", marginTop: 16, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>
                  다시 선택
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`* { box-sizing: border-box; } ::-webkit-scrollbar { width: 0; }`}</style>
    </div>
  );
};

export default SpotLog;
