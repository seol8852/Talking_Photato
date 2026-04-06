import React, { useState, useEffect, useRef } from "react";
import { Menu, X, Plus, MapPin, Heart, Upload, Loader2, Trash2, ArrowLeft, Check, AlertCircle } from "lucide-react";
import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import * as exifr from "exifr";

const GEO_URL =
  "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-topo.json";

// ── 유틸: EXIF에서 GPS + 시간 추출 ──
const extractPointsFromFiles = async (files) => {
  const results = [];
  for (const file of files) {
    try {
      const exif = await exifr.parse(file, {
        gps: true,
        tiff: true,
        exif: true,
        pick: ["latitude", "longitude", "DateTimeOriginal", "CreateDate"],
      });
      if (exif?.latitude && exif?.longitude) {
        results.push({
          lat: exif.latitude,
          lng: exif.longitude,
          time: exif.DateTimeOriginal || exif.CreateDate || null,
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

// ── 유틸: 좌표 → 시군구 이름 (카카오 역지오코딩) ──
const getRegionFromCoords = (lat, lng) => {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services) { resolve(null); return; }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.coord2RegionCode(lng, lat, (result, status) => {
      if (status === window.kakao.maps.services.Status.OK) {
        const region = result.find((r) => r.region_type === "B") || result.find((r) => r.region_type === "H");
        if (region) {
          const parts = region.address_name.split(" ");
          const sigungu = parts.find((p) => p.endsWith("구") || p.endsWith("시") || p.endsWith("군"));
          resolve(sigungu || region.region_2depth_name || null);
        } else { resolve(null); }
      } else { resolve(null); }
    });
  });
};

// ── 카카오 SDK 로드 대기 헬퍼 ──
const waitForKakao = (timeout = 5000) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (Date.now() - start > timeout) { clearInterval(check); resolve(false); return; }
      if (window.kakao) { clearInterval(check); window.kakao.maps.load(() => resolve(true)); }
    }, 100);
  });
};

// ── 카카오 상세 지도 컴포넌트 ──
const KakaoDetailMap = ({ data, onBack }) => {
  const mapContainer = useRef(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    let attempts = 0;
    const MAX_ATTEMPTS = 50;

    const checkKakao = setInterval(() => {
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(checkKakao);
        setErrorMsg("카카오맵을 불러오지 못했어요.\n앱키와 도메인 설정을 확인해주세요.");
        return;
      }
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
            map.setBounds(bounds, 60);
          }

          const linePath = data.points.map((p) => new kakao.maps.LatLng(p.lat, p.lng));
          new kakao.maps.Polyline({
            path: linePath,
            strokeWeight: 5,
            strokeColor: "#FF6B6B",
            strokeOpacity: 0.85,
            strokeStyle: "solid",
          }).setMap(map);

          linePath.forEach((pos, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === linePath.length - 1;
            const label = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `${idx + 1}`;
            const content = `<div style="background:#FF6B6B;color:white;padding:5px 11px;border-radius:20px;font-size:12px;font-weight:600;border:2px solid rgba(255,255,255,0.9);box-shadow:0 3px 10px rgba(0,0,0,0.35);white-space:nowrap;">${label}</div>`;
            new kakao.maps.CustomOverlay({ content, position: pos, yAnchor: 2.6 }).setMap(map);
          });

          setIsMapReady(true);
        } catch (err) {
          console.error("카카오맵 렌더링 오류:", err);
          setErrorMsg("지도를 렌더링하는 중 오류가 발생했어요.");
        }
      });
    }, 100);

    return () => clearInterval(checkKakao);
  }, [data]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>

      {/* 헤더 */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button
          onClick={onBack}
          style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer", flexShrink: 0 }}
        >
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

      {/* 로딩 */}
      {!isMapReady && !errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10 }}>
          <Loader2 className="animate-spin" size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>카카오맵 불러오는 중...</p>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 6 }}>처음 로드 시 잠시 걸릴 수 있어요</p>
        </div>
      )}

      {/* 오류 */}
      {errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10, padding: "0 32px" }}>
          <AlertCircle size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 14, color: "white", textAlign: "center", marginBottom: 8, whiteSpace: "pre-line" }}>{errorMsg}</p>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", textAlign: "center", lineHeight: 1.7 }}>
            카카오 콘솔 → 플랫폼 키 → JavaScript SDK 도메인에<br />
            localhost:5173 이 등록되어 있는지 확인해주세요
          </p>
        </div>
      )}

      {/* 지도 영역 — flex:1 + minHeight:0 으로 남은 공간 전체 차지 */}
      <div
        ref={mapContainer}
        style={{ flex: 1, width: "100%", minHeight: 0 }}
      />

      {/* 하단 포인트 목록 */}
      {isMapReady && data.points.length > 0 && (
        <div style={{ padding: "12px 16px", backgroundColor: "#0D0D16", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 8, overflowX: "auto", flexShrink: 0 }}>
          {data.points.map((p, idx) => (
            <div
              key={idx}
              style={{ flexShrink: 0, padding: "8px 12px", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, minWidth: 90 }}
            >
              <p style={{ fontSize: 10, color: "#FF6B6B", marginBottom: 3 }}>
                {idx === 0 ? "🚀 출발" : idx === data.points.length - 1 ? "🏁 도착" : `📍 ${idx + 1}`}
              </p>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
                {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
              </p>
              {p.time && (
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>
                  {new Date(p.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── 메인 앱 ──
const SpotLog = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [uploadStep, setUploadStep] = useState(0);
  const [previewFile, setPreviewFile] = useState(null);
  const [pendingPoints, setPendingPoints] = useState([]);
  const [pendingRegion, setPendingRegion] = useState(null);
  const [viewDetail, setViewDetail] = useState(null);
  const [filterYear, setFilterYear] = useState("전체");

  const [visitedLogs, setVisitedLogs] = useState([
    {
      id: 1,
      regionName: "강남구",
      date: "2026.03.30",
      points: [
        { lat: 37.5172, lng: 127.0412 },
        { lat: 37.5212, lng: 127.0392 },
        { lat: 37.5252, lng: 127.0452 },
      ],
    },
  ]);

  const getRegionName = (geo) => geo.properties.name || geo.properties.name_ko || "알 수 없는 지역";
  const visitedNames = visitedLogs.map((l) => l.regionName);
  const years = ["전체", ...new Set(visitedLogs.map((l) => l.date.split(".")[0]))].reverse();
  const filteredLogs = filterYear === "전체" ? visitedLogs : visitedLogs.filter((l) => l.date.startsWith(filterYear));

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setPreviewFile(URL.createObjectURL(files[0]));
    setUploadStep(1);
    try {
      const points = await extractPointsFromFiles(files);
      if (points.length === 0) { setUploadStep(3); return; }
      let regionName = selectedRegion;
      if (!regionName) {
        const kakaoReady = await waitForKakao(3000);
        if (kakaoReady) regionName = await getRegionFromCoords(points[0].lat, points[0].lng);
      }
      setPendingPoints(points);
      setPendingRegion(regionName || "알 수 없는 지역");
      setUploadStep(2);
    } catch (err) {
      console.error("EXIF 처리 오류:", err);
      setUploadStep(3);
    }
  };

  const handleSave = () => {
    const regionToSave = pendingRegion || selectedRegion || "알 수 없는 지역";
    const today = new Date();
    const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
    const newLog = {
      id: Date.now(),
      regionName: regionToSave,
      date: dateStr,
      points: pendingPoints.length > 0
        ? pendingPoints
        : [{ lat: 37.5665, lng: 126.978 }, { lat: 37.5695, lng: 126.982 }, { lat: 37.5635, lng: 126.985 }],
    };
    setVisitedLogs([newLog, ...visitedLogs]);
    closeModal();
  };

  const deleteLog = (id, e) => {
    e.stopPropagation();
    if (window.confirm("이 구역의 기록을 삭제할까요?")) {
      setVisitedLogs(visitedLogs.filter((l) => l.id !== id));
      setSelectedRegion(null);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setUploadStep(0);
    setPreviewFile(null);
    setPendingPoints([]);
    setPendingRegion(null);
  };

  return (
    <div
      className="w-full max-w-screen-xl mx-auto h-screen flex flex-col overflow-hidden relative"
      style={{ backgroundColor: "#0A0A0F", colorScheme: "dark" }}
    >
      {viewDetail && <KakaoDetailMap data={viewDetail} onBack={() => setViewDetail(null)} />}

      <div
        className="fixed top-0 left-1/2 -translate-x-1/2 pointer-events-none z-0"
        style={{ width: 600, height: 240, background: "radial-gradient(ellipse, rgba(255,107,107,0.07) 0%, transparent 70%)", filter: "blur(40px)" }}
      />

      {/* HEADER */}
      <header
        className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-screen-xl z-50 flex items-center justify-between px-5 py-4"
        style={{ background: "linear-gradient(to bottom, #0A0A0F 60%, transparent)" }}
      >
        <button
          onClick={() => setDrawerOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
          style={{ backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2">
          <Heart size={14} fill="#FF6B6B" color="#FF6B6B" />
          <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: "0.14em", color: "#FF6B6B", textTransform: "uppercase" }}>SpotLog</span>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-xl transition-all active:scale-95"
          style={{ backgroundColor: "#FF6B6B", color: "white", border: "none", cursor: "pointer", boxShadow: "0 4px 16px rgba(255,107,107,0.3)" }}
        >
          <Plus size={18} />
        </button>
      </header>

      {/* MAIN */}
      <main className="flex-1 pt-[72px] pb-4 px-4 flex flex-col gap-3 relative z-10 overflow-hidden">

        {/* 통계 바 */}
        <div
          className="flex justify-between items-center px-4 py-3.5 rounded-2xl"
          style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Our Footprints</p>
            <div className="flex items-baseline gap-1.5">
              <span style={{ fontSize: 22, fontWeight: 500, color: "#FF6B6B" }}>{visitedLogs.length}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>/ 250 시군구</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 6 }}>
              정복률 {((visitedLogs.length / 250) * 100).toFixed(1)}%
            </p>
            <div className="rounded-full overflow-hidden" style={{ width: 80, height: 3, backgroundColor: "rgba(255,255,255,0.08)" }}>
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max((visitedLogs.length / 250) * 100, 0.5)}%`, backgroundColor: "#FF6B6B" }}
              />
            </div>
          </div>
        </div>

        {/* 지도 */}
        <div
          className="flex-1 rounded-3xl overflow-hidden"
          style={{ backgroundColor: "rgba(255,255,255,0.015)", border: "1px solid rgba(255,255,255,0.04)", minHeight: 280 }}
        >
          <ComposableMap
            projection="geoMercator"
            projectionConfig={{ scale: 4500, center: [127.9, 36.2] }}
            style={{ width: "100%", height: "100%" }}
          >
            <ZoomableGroup zoom={1}>
              <Geographies geography={GEO_URL}>
                {({ geographies }) =>
                  geographies.map((geo) => {
                    const name = getRegionName(geo);
                    const visited = visitedNames.includes(name);
                    const selected = selectedRegion === name;
                    return (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        onClick={() => setSelectedRegion(name)}
                        style={{
                          default: {
                            fill: selected ? "#FF6B6B" : visited ? "rgba(255,107,107,0.28)" : "rgba(255,255,255,0.04)",
                            stroke: selected ? "rgba(255,255,255,0.4)" : visited ? "rgba(255,107,107,0.5)" : "rgba(255,255,255,0.18)",
                            strokeWidth: 0.5,
                            outline: "none",
                          },
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
        </div>

        {/* 하단 선택 바 */}
        <div className="shrink-0">
          {selectedRegion ? (
            <div
              className="flex items-center gap-3 px-4 py-3.5 rounded-2xl"
              style={{ backgroundColor: "#16161F", border: "1px solid rgba(255,107,107,0.2)" }}
            >
              <MapPin size={16} style={{ color: "#FF6B6B", flexShrink: 0 }} />
              <div className="flex-1" style={{ minWidth: 0 }}>
                <p style={{ fontSize: 10, color: "rgba(255,107,107,0.6)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                  {visitedNames.includes(selectedRegion) ? "Visited ✓" : "Selected Region"}
                </p>
                <p style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedRegion}
                </p>
              </div>
              {visitedNames.includes(selectedRegion) ? (
                <button
                  onClick={() => setViewDetail(visitedLogs.find((l) => l.regionName === selectedRegion))}
                  className="rounded-xl transition-colors"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, cursor: "pointer" }}
                >
                  동선 보기
                </button>
              ) : (
                <button
                  onClick={() => setModalOpen(true)}
                  className="rounded-xl transition-all active:scale-95"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "white", backgroundColor: "#FF6B6B", border: "none", flexShrink: 0, cursor: "pointer" }}
                >
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
              <button onClick={() => setDrawerOpen(false)} style={{ color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>
            <div className="flex gap-2 px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setFilterYear(y)}
                  className="rounded-lg transition-colors"
                  style={{
                    padding: "6px 12px", fontSize: 11,
                    border: filterYear === y ? "1px solid rgba(255,107,107,0.35)" : "1px solid rgba(255,255,255,0.08)",
                    backgroundColor: filterYear === y ? "rgba(255,107,107,0.1)" : "transparent",
                    color: filterYear === y ? "#FF6B6B" : "rgba(255,255,255,0.35)",
                    cursor: "pointer",
                  }}
                >
                  {y}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => { setViewDetail(log); setDrawerOpen(false); }}
                  className="flex items-center gap-3 rounded-xl cursor-pointer"
                  style={{ padding: "12px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", transition: "border-color 0.2s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,107,107,0.2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)")}
                >
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 3 }}>{log.date}</p>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      📍 {log.regionName} · {log.points.length}곳
                    </p>
                  </div>
                  <button
                    onClick={(e) => deleteLog(log.id, e)}
                    style={{ padding: 6, color: "rgba(255,255,255,0.2)", background: "none", border: "none", cursor: "pointer", transition: "color 0.2s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.2)")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {filteredLogs.length === 0 && (
                <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", padding: "40px 0", fontStyle: "italic" }}>기록이 없어요</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-[2000] flex items-end justify-center">
          <div className="absolute inset-0 backdrop-blur-sm" style={{ backgroundColor: "rgba(0,0,0,0.7)" }} onClick={closeModal} />
          <div
            className="relative w-full"
            style={{ maxWidth: 420, backgroundColor: "#0D0D16", border: "1px solid rgba(255,255,255,0.08)", borderBottom: "none", borderRadius: "28px 28px 0 0", padding: "20px 20px 32px" }}
          >
            <div className="mx-auto mb-5" style={{ width: 36, height: 3, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2 }} />

            {/* Step 0 */}
            {uploadStep === 0 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 20 }}>추억 업로드</h3>
                <label
                  className="flex flex-col items-center gap-3 w-full cursor-pointer rounded-2xl"
                  style={{ padding: "40px 20px", border: "1.5px dashed rgba(255,255,255,0.1)", backgroundColor: "rgba(255,255,255,0.01)", transition: "all 0.2s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,107,107,0.3)"; e.currentTarget.style.backgroundColor = "rgba(255,107,107,0.02)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.01)"; }}
                >
                  <Upload size={22} style={{ color: "#FF6B6B" }} />
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginBottom: 4 }}>사진을 선택하면 EXIF 위치 데이터로</p>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)" }}>동선이 자동 생성됩니다</p>
                  </div>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)" }}>JPG · HEIC · PNG · 여러 장 선택 가능</p>
                  <input type="file" className="hidden" onChange={handleFileUpload} accept="image/*" multiple />
                </label>
              </>
            )}

            {/* Step 1 */}
            {uploadStep === 1 && (
              <div className="flex flex-col items-center gap-4" style={{ padding: "48px 0" }}>
                <Loader2 className="animate-spin" size={32} style={{ color: "#FF6B6B" }} />
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: "white", marginBottom: 4 }}>위치 데이터 분석 중</p>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>EXIF GPS 정보를 읽고 있어요...</p>
                </div>
              </div>
            )}

            {/* Step 2 */}
            {uploadStep === 2 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 16 }}>분석 완료</h3>
                <div className="rounded-2xl overflow-hidden relative" style={{ height: 120, marginBottom: 14 }}>
                  <img src={previewFile} className="w-full h-full object-cover" alt="preview" />
                  <div className="absolute inset-0" style={{ backgroundColor: "rgba(0,0,0,0.3)" }} />
                  <div className="absolute bottom-3 right-3" style={{ padding: "4px 10px", backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 20 }}>
                    <span style={{ fontSize: 11, color: "white" }}>📍 {pendingPoints.length}개 위치 감지</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-xl" style={{ padding: "12px 16px", marginBottom: 16, backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)" }}>
                  <Check size={16} style={{ color: "#FF6B6B", flexShrink: 0 }} />
                  <div>
                    <p style={{ fontSize: 11, color: "rgba(255,107,107,0.6)", marginBottom: 2 }}>구역 감지됨</p>
                    <p style={{ fontSize: 14, fontWeight: 500, color: "#FF6B6B" }}>{pendingRegion || selectedRegion || "미정"}</p>
                  </div>
                </div>
                <button
                  onClick={handleSave}
                  className="w-full rounded-xl transition-all active:scale-[0.98]"
                  style={{ padding: 14, backgroundColor: "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", cursor: "pointer" }}
                >
                  기록 저장하기
                </button>
              </>
            )}

            {/* Step 3: GPS 없음 */}
            {uploadStep === 3 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 16 }}>위치 정보 없음</h3>
                <div className="flex flex-col items-center gap-3 rounded-2xl" style={{ padding: "32px 20px", backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <AlertCircle size={28} style={{ color: "rgba(255,255,255,0.3)" }} />
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>사진에 GPS 정보가 없어요</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>
                      카메라 앱에서 위치 권한을 허용하거나<br />
                      지도에서 구역을 먼저 선택 후 기록해보세요
                    </p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button
                    onClick={() => setUploadStep(0)}
                    className="rounded-xl"
                    style={{ flex: 1, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}
                  >
                    다시 선택
                  </button>
                  {selectedRegion && (
                    <button
                      onClick={handleSave}
                      className="rounded-xl transition-all active:scale-[0.98]"
                      style={{ flex: 1, padding: 12, backgroundColor: "#FF6B6B", color: "white", fontSize: 13, border: "none", cursor: "pointer" }}
                    >
                      {selectedRegion}만 저장
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 0; }
      `}</style>
    </div>
  );
};

export default SpotLog;
