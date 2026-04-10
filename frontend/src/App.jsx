import React, { useState, useEffect, useRef } from "react";
import { Menu, X, Plus, MapPin, Heart, Upload, Loader2, Trash2, ArrowLeft, Check, AlertCircle, LogOut, ChevronRight, Calendar, Pencil } from "lucide-react";
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

const getDominantRegionAndPoints = async (points) => {
  const regionMap = {};
  for (const p of points) {
    const region = await getRegionFromCoords(p.lat, p.lng);
    const key = region || "__unknown__";
    if (!regionMap[key]) regionMap[key] = [];
    regionMap[key].push(p);
  }
  const entries = Object.entries(regionMap).filter(([k]) => k !== "__unknown__");
  if (!entries.length) return { regionName: null, points };
  entries.sort((a, b) => b[1].length - a[1].length);
  return { regionName: entries[0][0], points: entries[0][1] };
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

  if (!data.points || data.points.length === 0) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 9999, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
          <button onClick={onBack} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
            <ArrowLeft size={18} />
          </button>
          <h3 style={{ fontSize: 15, fontWeight: 500, color: "white" }}>{data.regionName} 동선</h3>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 40px", gap: 16 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <MapPin size={24} style={{ color: "rgba(255,255,255,0.3)" }} />
          </div>
          <div style={{ textAlign: "center" }}>
            <p style={{ fontSize: 15, fontWeight: 500, color: "white", marginBottom: 8 }}>위치 정보 없음</p>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", lineHeight: 1.7 }}>이 기록은 GPS 정보 없이 저장되어<br />동선을 표시할 수 없어요</p>
          </div>
          <div style={{ padding: "12px 20px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, textAlign: "center" }}>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>다음에 사진을 업로드할 때 카메라 앱에서<br />위치 권한을 허용하면 동선이 자동 생성돼요</p>
          </div>
        </div>
      </div>
    );
  }

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
      {isMapReady && (
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

// ── 여행 상세 화면 ──
const TripDetailView = ({ trip, visits, onBack, onViewDetail, onDeleteVisit, onDeleteTrip }) => {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 5000, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>
      {/* 헤더 */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Trip</p>
          <h3 style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trip.title}</h3>
        </div>
        <button
          onClick={() => onDeleteTrip(trip.id)}
          style={{ padding: "6px 10px", borderRadius: 10, backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.3)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
        >
          <Trash2 size={13} /> 삭제
        </button>
      </div>

      {/* 여행 기간 */}
      <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
        <Calendar size={14} style={{ color: "rgba(255,255,255,0.3)" }} />
        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
          {trip.started_at} ~ {trip.ended_at}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
          총 {visits.length}일
        </span>
      </div>

      {/* 날짜별 방문 목록 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {visits.length === 0 ? (
          <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", padding: "40px 0", fontStyle: "italic" }}>기록이 없어요</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visits.map((visit, idx) => (
              <div
                key={visit.id}
                style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 16, overflow: "hidden" }}
              >
                {/* 날짜 헤더 */}
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", backgroundColor: "rgba(255,107,107,0.15)", border: "1px solid rgba(255,107,107,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 10, color: "#FF6B6B", fontWeight: 600 }}>Day {idx + 1}</span>
                  </div>
                  <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{visit.date}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,107,107,0.6)" }}>📍 {visit.regionName}</span>
                </div>

                {/* 포인트 수 + 버튼 */}
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>
                    {visit.points.length > 0 ? `${visit.points.length}곳 방문` : "위치 정보 없음"}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => onDeleteVisit(visit.id)}
                      style={{ padding: "6px 10px", borderRadius: 8, backgroundColor: "transparent", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.25)", cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      onClick={() => onViewDetail(visit)}
                      style={{ padding: "6px 14px", borderRadius: 8, backgroundColor: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", color: "#FF6B6B", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
                    >
                      동선 보기 <ChevronRight size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ── 메인 앱 ──
const SpotLog = ({ user, couple, onLogout }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [uploadStep, setUploadStep] = useState(0); // 0:idle 1:exif 2:title 3:preview 4:no-gps
  const [previewFile, setPreviewFile] = useState(null);
  const [pendingGroups, setPendingGroups] = useState([]);
  const [tripTitle, setTripTitle] = useState("");
  const [viewDetail, setViewDetail] = useState(null);
  const [viewTrip, setViewTrip] = useState(null);
  const [filterYear, setFilterYear] = useState("전체");

  const [trips, setTrips] = useState([]);
  const [visits, setVisits] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);

  // ── DB 조회 ──
  const fetchAll = async () => {
    const [{ data: tripsData }, { data: visitsData }] = await Promise.all([
      supabase.from("trips").select("*").eq("couple_id", couple.id).order("started_at", { ascending: false }),
      supabase.from("visits").select("*").eq("couple_id", couple.id).order("date", { ascending: true }),
    ]);
    setTrips(tripsData || []);
    setVisits((visitsData || []).map((r) => ({ id: r.id, tripId: r.trip_id, regionName: r.region_name, date: r.date, points: r.points })));
    setDbLoading(false);
  };

  useEffect(() => {
    fetchAll();
    const channel = supabase
      .channel(`couple-${couple.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "trips", filter: `couple_id=eq.${couple.id}` }, fetchAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "visits", filter: `couple_id=eq.${couple.id}` }, fetchAll)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [couple.id]);

  const getGeoKey = (geo) => buildKeyFromCode(geo.properties.name, geo.properties.code);

  // 지도 색칠용: 모든 visit의 regionName
  const visitedNames = visits.map((v) => v.regionName);

  // 여행에 속한 visits
  const getVisitsForTrip = (tripId) => visits.filter((v) => v.tripId === tripId);

  const years = ["전체", ...new Set(trips.map((t) => t.started_at.split(".")[0]))].reverse();
  const filteredTrips = filterYear === "전체" ? trips : trips.filter((t) => t.started_at.startsWith(filterYear));

  // ── 파일 업로드 & EXIF 파싱 ──
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setPreviewFile(URL.createObjectURL(files[0]));
    setUploadStep(1);
    try {
      const points = await extractPointsFromFiles(files);
      if (points.length === 0) { setUploadStep(4); return; }
      const groups = groupPointsByDate(points);
      const initialGroups = groups.map((g) => ({ ...g, regionName: null, dominantPoints: null, totalPoints: g.points.length, analyzing: true }));
      setPendingGroups(initialGroups);

      // 여행 제목 입력 단계로
      setUploadStep(2);

      // 백그라운드에서 지역 분석
      const kakaoReady = await waitForKakao(3000);
      if (kakaoReady) {
        for (let i = 0; i < groups.length; i++) {
          const { regionName, points: dominantPoints } = await getDominantRegionAndPoints(groups[i].points);
          setPendingGroups((prev) =>
            prev.map((g, idx) => idx === i ? { ...g, regionName: regionName || null, dominantPoints, analyzing: false } : g)
          );
        }
      } else {
        setPendingGroups((prev) => prev.map((g) => ({ ...g, regionName: null, dominantPoints: g.points, analyzing: false })));
      }
    } catch (err) {
      console.error("EXIF 처리 오류:", err);
      setUploadStep(4);
    }
  };

  // ── 저장: trip 생성 → visits 일괄 삽입 ──
  const handleSave = async () => {
    const title = tripTitle.trim() || "우리의 여행";
    const dates = pendingGroups
      .filter((g) => g.date)
      .map((g) => formatDate(g.date))
      .sort();
    const startedAt = dates[0] || formatDate(new Date());
    const endedAt = dates[dates.length - 1] || startedAt;

    // 1) trip 생성
    const { data: tripData, error: tripError } = await supabase
      .from("trips")
      .insert({ couple_id: couple.id, title, started_at: startedAt, ended_at: endedAt })
      .select().single();
    if (tripError) { console.error("여행 생성 실패:", tripError); alert("저장에 실패했어요."); return; }

    // 2) visits 일괄 삽입
    const rows = pendingGroups.map((group) => ({
      couple_id: couple.id,
      trip_id: tripData.id,
      region_name: group.regionName || selectedRegion || "알 수 없는 지역",
      date: group.date ? formatDate(group.date) : formatDate(new Date()),
      points: group.dominantPoints || group.points,
    }));
    const { error: visitsError } = await supabase.from("visits").insert(rows);
    if (visitsError) { console.error("기록 저장 실패:", visitsError); alert("저장에 실패했어요."); return; }

    closeModal();
  };

  // ── GPS 없이 구역만 저장 ──
  const handleSaveWithSelectedRegion = async () => {
    if (!selectedRegion) return;
    const title = tripTitle.trim() || selectedRegion;
    const today = formatDate(new Date());
    const { data: tripData, error: tripError } = await supabase
      .from("trips")
      .insert({ couple_id: couple.id, title, started_at: today, ended_at: today })
      .select().single();
    if (tripError) { alert("저장에 실패했어요."); return; }
    await supabase.from("visits").insert([{ couple_id: couple.id, trip_id: tripData.id, region_name: selectedRegion, date: today, points: [] }]);
    closeModal();
  };

  // ── 여행 삭제 (cascade로 visits도 삭제됨) ──
  const deleteTrip = async (tripId) => {
    if (!window.confirm("이 여행 전체를 삭제할까요? 안에 있는 기록도 모두 사라져요.")) return;
    await supabase.from("trips").delete().eq("id", tripId);
    setViewTrip(null);
  };

  // ── visit 개별 삭제 ──
  const deleteVisit = async (visitId) => {
    if (!window.confirm("이 날의 기록을 삭제할까요?")) return;
    await supabase.from("visits").delete().eq("id", visitId);
  };

  const closeModal = () => {
    setModalOpen(false);
    setUploadStep(0);
    setPreviewFile(null);
    setPendingGroups([]);
    setTripTitle("");
  };

  const isAnalyzing = pendingGroups.some((g) => g.analyzing);

  // 현재 보고있는 여행의 visits
  const currentTripVisits = viewTrip ? getVisitsForTrip(viewTrip.id) : [];

  return (
    <div className="w-full max-w-screen-xl mx-auto h-screen flex flex-col overflow-hidden relative" style={{ backgroundColor: "#0A0A0F", colorScheme: "dark" }}>

      {/* 카카오 상세 지도 */}
      {viewDetail && <KakaoDetailMap data={viewDetail} onBack={() => setViewDetail(null)} />}

      {/* 여행 상세 화면 */}
      {viewTrip && !viewDetail && (
        <TripDetailView
          trip={viewTrip}
          visits={currentTripVisits}
          onBack={() => setViewTrip(null)}
          onViewDetail={(visit) => setViewDetail(visit)}
          onDeleteVisit={deleteVisit}
          onDeleteTrip={deleteTrip}
        />
      )}

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
              <span style={{ fontSize: 22, fontWeight: 500, color: "#FF6B6B" }}>{new Set(visitedNames).size}</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>/ 250 시군구</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", marginBottom: 6 }}>정복률 {((new Set(visitedNames).size / 250) * 100).toFixed(1)}%</p>
            <div className="rounded-full overflow-hidden" style={{ width: 80, height: 3, backgroundColor: "rgba(255,255,255,0.08)" }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max((new Set(visitedNames).size / 250) * 100, 0.5)}%`, backgroundColor: "#FF6B6B" }} />
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
                <button
                  onClick={() => {
                    const relatedVisit = visits.find((v) => v.regionName === selectedRegion);
                    if (relatedVisit?.tripId) {
                      const trip = trips.find((t) => t.id === relatedVisit.tripId);
                      if (trip) setViewTrip(trip);
                    }
                  }}
                  className="rounded-xl"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, cursor: "pointer" }}
                >
                  여행 보기
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
            <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{user?.email}</p>
              <button onClick={onLogout} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", fontSize: 11, cursor: "pointer" }}>
                <LogOut size={12} /> 로그아웃
              </button>
            </div>
            <div className="flex gap-2 px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", flexWrap: "wrap" }}>
              {years.map((y) => (
                <button key={y} onClick={() => setFilterYear(y)} className="rounded-lg"
                  style={{ padding: "6px 12px", fontSize: 11, border: filterYear === y ? "1px solid rgba(255,107,107,0.35)" : "1px solid rgba(255,255,255,0.08)", backgroundColor: filterYear === y ? "rgba(255,107,107,0.1)" : "transparent", color: filterYear === y ? "#FF6B6B" : "rgba(255,255,255,0.35)", cursor: "pointer" }}>
                  {y}
                </button>
              ))}
            </div>

            {/* 여행 목록 */}
            <div className="flex-1 overflow-y-auto px-4 py-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredTrips.map((trip) => {
                const tripVisits = getVisitsForTrip(trip.id);
                return (
                  <div
                    key={trip.id}
                    onClick={() => { setViewTrip(trip); setDrawerOpen(false); }}
                    className="rounded-xl cursor-pointer"
                    style={{ padding: "14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", transition: "border-color 0.2s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,107,107,0.2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)")}
                  >
                    {/* 여행 제목 */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <p style={{ fontSize: 14, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{trip.title}</p>
                      <ChevronRight size={14} style={{ color: "rgba(255,255,255,0.25)", flexShrink: 0 }} />
                    </div>
                    {/* 날짜 범위 */}
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>
                      {trip.started_at === trip.ended_at ? trip.started_at : `${trip.started_at} ~ ${trip.ended_at}`}
                    </p>
                    {/* 지역 태그 */}
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[...new Set(tripVisits.map((v) => v.regionName))].slice(0, 3).map((r) => (
                        <span key={r} style={{ fontSize: 10, color: "rgba(255,107,107,0.7)", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)", borderRadius: 6, padding: "2px 8px" }}>
                          {r}
                        </span>
                      ))}
                      {new Set(tripVisits.map((v) => v.regionName)).size > 3 && (
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", padding: "2px 4px" }}>
                          +{new Set(tripVisits.map((v) => v.regionName)).size - 3}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredTrips.length === 0 && (
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
          <div className="relative w-full" style={{ maxWidth: 420, backgroundColor: "#0D0D16", border: "1px solid rgba(255,255,255,0.08)", borderBottom: "none", borderRadius: "28px 28px 0 0", padding: "20px 20px 32px" }}>
            <div className="mx-auto mb-5" style={{ width: 36, height: 3, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 2 }} />

            {/* Step 0: 사진 선택 */}
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

            {/* Step 1: EXIF 분석 중 */}
            {uploadStep === 1 && (
              <div className="flex flex-col items-center gap-4" style={{ padding: "48px 0" }}>
                <Loader2 className="animate-spin" size={32} style={{ color: "#FF6B6B" }} />
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: "white", marginBottom: 4 }}>위치 데이터 분석 중</p>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>EXIF GPS 정보를 읽고 있어요...</p>
                </div>
              </div>
            )}

            {/* Step 2: 여행 이름 입력 */}
            {uploadStep === 2 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 6 }}>여행 이름 짓기</h3>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 20 }}>
                  {pendingGroups.length}일치 사진이 감지됐어요. 이 여행의 이름을 지어주세요!
                </p>
                <div style={{ position: "relative", marginBottom: 16 }}>
                  <Pencil size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
                  <input
                    type="text"
                    placeholder="예: 경주 벚꽃 여행 🌸"
                    value={tripTitle}
                    onChange={(e) => setTripTitle(e.target.value)}
                    maxLength={30}
                    style={{ width: "100%", padding: "12px 16px 12px 40px", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(255,107,107,0.4)")}
                    onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                    autoFocus
                  />
                </div>

                {/* 감지된 날짜 미리보기 */}
                <div style={{ padding: "12px 14px", backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, marginBottom: 20 }}>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>감지된 일정</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {pendingGroups.map((g, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ color: "rgba(255,107,107,0.6)", minWidth: 40 }}>Day {idx + 1}</span>
                        <span style={{ color: "rgba(255,255,255,0.4)" }}>{g.date ? formatDate(g.date) : "날짜 미상"}</span>
                        {g.analyzing
                          ? <Loader2 size={10} className="animate-spin" style={{ color: "rgba(255,255,255,0.2)", marginLeft: "auto" }} />
                          : <span style={{ color: "rgba(255,107,107,0.5)", marginLeft: "auto" }}>{g.regionName || "분석 중"}</span>
                        }
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => setUploadStep(3)}
                  style={{ width: "100%", padding: 14, backgroundColor: "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", borderRadius: 12, cursor: "pointer" }}
                >
                  다음
                </button>
              </>
            )}

            {/* Step 3: 최종 확인 및 저장 */}
            {uploadStep === 3 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <button onClick={() => setUploadStep(2)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: 0 }}>
                    <ArrowLeft size={16} />
                  </button>
                  <h3 style={{ fontSize: 16, fontWeight: 500, color: "white" }}>저장 확인</h3>
                  {isAnalyzing && (
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <Loader2 size={13} className="animate-spin" style={{ color: "#FF6B6B" }} />
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>지역 분석 중</span>
                    </div>
                  )}
                </div>

                {/* 여행 제목 카드 */}
                <div style={{ padding: "14px 16px", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 14, marginBottom: 12 }}>
                  <p style={{ fontSize: 11, color: "rgba(255,107,107,0.5)", marginBottom: 4 }}>여행 이름</p>
                  <p style={{ fontSize: 16, fontWeight: 500, color: "#FF6B6B" }}>{tripTitle.trim() || "우리의 여행"}</p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
                    {pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort()[0]} ~{" "}
                    {pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort().slice(-1)[0]}
                  </p>
                </div>

                {/* 날짜별 요약 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, maxHeight: 200, overflowY: "auto" }}>
                  {pendingGroups.map((group, idx) => (
                    <div key={idx} style={{ padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: "white", fontWeight: 600 }}>{idx + 1}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{group.date ? formatDate(group.date) : "날짜 미상"}</span>
                      </div>
                      {group.analyzing
                        ? <Loader2 size={11} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
                        : <span style={{ fontSize: 12, color: "#FF6B6B" }}>{group.regionName || "지역 미상"}</span>
                      }
                    </div>
                  ))}
                </div>

                <button onClick={handleSave} disabled={isAnalyzing} className="w-full rounded-xl"
                  style={{ padding: 14, backgroundColor: isAnalyzing ? "rgba(255,107,107,0.4)" : "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", cursor: isAnalyzing ? "not-allowed" : "pointer" }}>
                  {isAnalyzing ? "분석 완료 후 저장 가능" : "저장하기"}
                </button>
              </>
            )}

            {/* Step 4: GPS 없음 */}
            {uploadStep === 4 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 16 }}>위치 정보 없음</h3>
                <div className="flex flex-col items-center gap-3 rounded-2xl" style={{ padding: "28px 20px", backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <AlertCircle size={28} style={{ color: "rgba(255,255,255,0.3)" }} />
                  <div style={{ textAlign: "center" }}>
                    <p style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>사진에 GPS 정보가 없어요</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>카메라 앱에서 위치 권한을 허용하거나<br />지도에서 구역을 선택하고 기록할 수 있어요</p>
                  </div>
                </div>
                {selectedRegion ? (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ padding: "12px 16px", marginBottom: 12, backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
                      <Check size={15} style={{ color: "#FF6B6B", flexShrink: 0 }} />
                      <div>
                        <p style={{ fontSize: 11, color: "rgba(255,107,107,0.6)", marginBottom: 2 }}>선택된 구역</p>
                        <p style={{ fontSize: 14, fontWeight: 500, color: "#FF6B6B" }}>{selectedRegion}</p>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setUploadStep(0)} className="rounded-xl"
                        style={{ flex: 1, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>
                        다시 선택
                      </button>
                      <button onClick={handleSaveWithSelectedRegion} className="rounded-xl"
                        style={{ flex: 1, padding: 12, backgroundColor: "#FF6B6B", color: "white", fontSize: 13, fontWeight: 500, border: "none", cursor: "pointer" }}>
                        {selectedRegion} 저장
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <button onClick={() => setUploadStep(0)} className="rounded-xl"
                      style={{ flex: 1, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>
                      다시 선택
                    </button>
                    <button onClick={closeModal} className="rounded-xl"
                      style={{ flex: 1, padding: 12, backgroundColor: "transparent", color: "rgba(255,255,255,0.4)", fontSize: 13, border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}>
                      닫기
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 0; }
        input::placeholder { color: rgba(255,255,255,0.25); }
      `}</style>
    </div>
  );
};

export default SpotLog;
