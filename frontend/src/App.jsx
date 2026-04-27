import React, { useState, useEffect, useRef, useCallback } from "react";
import { Menu, X, Plus, MapPin, Heart, Upload, Loader2, Trash2, ArrowLeft, Check, AlertCircle, LogOut, ChevronRight, Calendar, Pencil, Navigation, Image, ZoomIn } from "lucide-react";
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

// ✅ 버그 2 수정: 고성군 등 추가
const DUPLICATE_NAMES = new Set([
  "중구", "남구", "북구", "동구", "서구",
  "강서구", "강동구", "강남구", "강북구", "수성구", "달서구",
  "고성군", "연천군", "철원군", "양구군", "인제군", "화천군", "양양군",
]);

const COMPLEX_BUILDING_KEYWORDS = [
  "백화점", "쇼핑몰", "아울렛", "마트", "역사", "터미널", "공항",
  "병원", "대학교", "대학", "호텔", "리조트", "테마파크",
];

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


// ── Supabase Storage에 사진 업로드 → public URL 배열 반환 ──
const uploadPhotosToStorage = async (files, coupleId, dateKey) => {
  const urls = [];
  for (const file of files) {
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      const path = `${coupleId}/${dateKey}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      const { error } = await supabase.storage.from('trip-photos').upload(path, file, { upsert: false });
      if (error) { console.warn('사진 업로드 실패:', error); continue; }
      const { data: { publicUrl } } = supabase.storage.from('trip-photos').getPublicUrl(path);
      urls.push(publicUrl);
    } catch (err) {
      console.warn('사진 업로드 오류:', err);
    }
  }
  return urls;
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

// 기존 getSmartLocationLabel 함수 전체를 이걸로 교체
const getSmartLocationLabel = (lat, lng) => {
  return new Promise((resolve) => {
    if (!window.kakao?.maps?.services) {
      resolve({ placeName: null, address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, isLowAccuracy: true });
      return;
    }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.coord2Address(lng, lat, (addrResult, addrStatus) => {
      if (addrStatus === window.kakao.maps.services.Status.OK && addrResult[0]) {
        const road = addrResult[0].road_address;
        const jibun = addrResult[0].address;
        // 도로명 주소 우선: "경주시 첨성로" 형태
        // 없으면 지번: "경주시 황남동" 형태
        const placeName = road
          ? `${road.region_2depth_name} ${road.road_name}`
          : `${jibun.region_2depth_name} ${jibun.region_3depth_name}`;
        const address = road
          ? `${road.region_1depth_name} ${road.region_2depth_name}`
          : `${jibun.region_1depth_name} ${jibun.region_2depth_name}`;
        resolve({ placeName, address, isLowAccuracy: false });
      } else {
        resolve({ placeName: null, address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, isLowAccuracy: true });
      }
    });
  });
};

// ── 포인트 라벨 (동선 모드 하단) ──
const PointLabel = ({ point, index, total }) => {
  const [label, setLabel] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSmartLocationLabel(point.lat, point.lng).then((result) => {
      setLabel(result);
      setLoading(false);
    });
  }, [point.lat, point.lng]);

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const tag = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `📍 ${index + 1}`;

  return (
    <div style={{ flexShrink: 0, padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, minWidth: 140, maxWidth: 200 }}>
      <p style={{ fontSize: 10, color: "#FF6B6B", marginBottom: 5, fontWeight: 600 }}>{tag}</p>
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Loader2 size={11} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>위치 분석 중...</span>
        </div>
      ) : (
        <>
          {label?.placeName && <p style={{ fontSize: 13, fontWeight: 500, color: "white", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.placeName}</p>}
          {label?.address && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.address}</p>}
          {label?.isLowAccuracy && <p style={{ fontSize: 10, color: "rgba(255,107,107,0.5)", marginTop: 2 }}>위치 정밀도가 낮아요</p>}
        </>
      )}
      {point.time && <p style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 4 }}>{new Date(point.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</p>}
    </div>
  );
};

// ── 스팟 상세 (스팟 모드 하단 패널) ──
const SpotDetail = ({ point, index, total, photoUrls }) => {
  const [label, setLabel] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setLabel(null);
    getSmartLocationLabel(point.lat, point.lng).then((result) => {
      setLabel(result);
      setLoading(false);
    });
  }, [point.lat, point.lng]);

  const tag = index === 0 ? "🚀 출발" : index === total - 1 ? "🏁 도착" : `스팟 ${index + 1}`;
  return (
    <div>
      <p style={{ fontSize: 10, color: "#FF6B6B", marginBottom: 4, fontWeight: 600 }}>{tag}</p>
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Loader2 size={12} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>위치 분석 중...</span>
        </div>
      ) : (
        <>
          {label?.placeName && <p style={{ fontSize: 14, fontWeight: 500, color: "white", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.placeName}</p>}
          {label?.address && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.address}</p>}
          {!label?.placeName && !label?.address && <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</p>}
        </>
      )}
      {point.time && <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 3 }}>{new Date(point.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</p>}
      {photoUrls && photoUrls.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto" }}>
          {photoUrls.slice(0, 5).map((url, i) => (
            <img key={i} src={url} alt=""
              style={{ width: 52, height: 52, borderRadius: 8, objectFit: "cover", flexShrink: 0, border: "1px solid rgba(255,255,255,0.1)" }} />
          ))}
        </div>
      )}
    </div>
  );
};

// ── 카카오 상세 지도 ──
// ✅ 버그 1 수정: GPS 없음 조기 return을 훅 아래로 이동
const KakaoDetailMap = ({ data, onBack, photoUrls }) => {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const overlaysRef = useRef([]);
  const polylineRef = useRef(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [viewMode, setViewMode] = useState("route");
  const [activeSpot, setActiveSpot] = useState(null);
  const hasPoints = data.points && data.points.length > 0;

  const clearOverlays = useCallback(() => {
    overlaysRef.current.forEach((o) => o.setMap(null));
    overlaysRef.current = [];
    if (polylineRef.current) { polylineRef.current.setMap(null); polylineRef.current = null; }
  }, []);

  const renderRouteMode = useCallback(() => {
    const map = mapRef.current;
    if (!map || !hasPoints) return;
    const { kakao } = window;
    clearOverlays();
    const linePath = data.points.map((p) => new kakao.maps.LatLng(p.lat, p.lng));
    const poly = new kakao.maps.Polyline({ path: linePath, strokeWeight: 5, strokeColor: "#FF6B6B", strokeOpacity: 0.85, strokeStyle: "solid" });
    poly.setMap(map);
    polylineRef.current = poly;
    linePath.forEach((pos, idx) => {
      const isFirst = idx === 0, isLast = idx === linePath.length - 1;
      const label = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `${idx + 1}`;
      const content = `<div style="background:#FF6B6B;color:white;padding:5px 11px;border-radius:20px;font-size:12px;font-weight:600;border:2px solid rgba(255,255,255,0.9);box-shadow:0 3px 10px rgba(0,0,0,0.35);white-space:nowrap;">${label}</div>`;
      const overlay = new kakao.maps.CustomOverlay({ content, position: pos, yAnchor: 2.6 });
      overlay.setMap(map);
      overlaysRef.current.push(overlay);
    });
  }, [data.points, hasPoints, clearOverlays]);

  const renderSpotMode = useCallback(() => {
    const map = mapRef.current;
    if (!map || !hasPoints) return;
    const { kakao } = window;
    clearOverlays();
    data.points.forEach((p, idx) => {
      const pos = new kakao.maps.LatLng(p.lat, p.lng);
      const isFirst = idx === 0, isLast = idx === data.points.length - 1;
      const dot = isFirst || isLast ? "#FF4444" : "#FF6B6B";
      const ring = isFirst || isLast ? "3px solid white" : "2px solid rgba(255,255,255,0.8)";
      const size = isFirst || isLast ? "20px" : "16px";
      const content = `<div data-idx="${idx}" onclick="window.__spotClick(${idx})" style="width:${size};height:${size};background:${dot};border-radius:50%;border:${ring};box-shadow:0 2px 8px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.15s;" onmouseover="this.style.transform='scale(1.3)'" onmouseout="this.style.transform='scale(1)'"></div>`;
      const overlay = new kakao.maps.CustomOverlay({ content, position: pos, yAnchor: 0.5, xAnchor: 0.5 });
      overlay.setMap(map);
      overlaysRef.current.push(overlay);
    });
  }, [data.points, hasPoints, clearOverlays]);

  useEffect(() => {
    window.__spotClick = (idx) => setActiveSpot((prev) => (prev === idx ? null : idx));
    return () => { delete window.__spotClick; };
  }, []);

  useEffect(() => {
    if (!hasPoints) return;
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
          mapRef.current = map;
          if (data.points.length > 1) {
            const bounds = new kakao.maps.LatLngBounds();
            data.points.forEach((p) => bounds.extend(new kakao.maps.LatLng(p.lat, p.lng)));
            map.setBounds(bounds, 80);
          }
          renderRouteMode();
          setIsMapReady(true);
        } catch (err) { setErrorMsg("지도를 렌더링하는 중 오류가 발생했어요."); }
      });
    }, 100);
    return () => clearInterval(checkKakao);
  }, [data, hasPoints]);

  useEffect(() => {
    if (!isMapReady) return;
    setActiveSpot(null);
    if (viewMode === "route") renderRouteMode();
    else renderSpotMode();
  }, [viewMode, isMapReady]);

  // ✅ 훅이 모두 선언된 후 조기 반환
  if (!hasPoints) {
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

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>
      {/* 헤더 */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Spot Detail</p>
          <h3 style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.regionName} 동선</h3>
        </div>

        {/* ✅ 버튼 1 수정: 뷰 모드 토글 */}
        <div style={{ display: "flex", backgroundColor: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, overflow: "hidden", flexShrink: 0 }}>
          <button
            onClick={() => setViewMode("route")}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", border: "none", cursor: "pointer", backgroundColor: viewMode === "route" ? "#FF6B6B" : "transparent", color: viewMode === "route" ? "white" : "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: viewMode === "route" ? 500 : 400, transition: "all 0.2s" }}
          >
            <Navigation size={13} /> 동선
          </button>
          <button
            onClick={() => setViewMode("spot")}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", border: "none", cursor: "pointer", backgroundColor: viewMode === "spot" ? "#FF6B6B" : "transparent", color: viewMode === "spot" ? "white" : "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: viewMode === "spot" ? 500 : 400, transition: "all 0.2s" }}
          >
            <MapPin size={13} /> 스팟
          </button>
        </div>
      </div>

      {/* 로딩 / 오류 */}
      {!isMapReady && !errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10 }}>
          <Loader2 className="animate-spin" size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>카카오맵 불러오는 중...</p>
        </div>
      )}
      {errorMsg && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10, padding: "0 32px" }}>
          <AlertCircle size={36} style={{ color: "#FF6B6B", marginBottom: 12 }} />
          <p style={{ fontSize: 14, color: "white", textAlign: "center" }}>{errorMsg}</p>
        </div>
      )}

      {/* 지도 */}
      <div ref={mapContainer} style={{ flex: 1, width: "100%", minHeight: 0 }} />

      {/* 동선 모드 하단 */}
      {isMapReady && viewMode === "route" && (
        <div style={{ padding: "12px 16px", backgroundColor: "#0D0D16", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 10, overflowX: "auto", flexShrink: 0 }}>
          {data.points.map((p, idx) => (
            <PointLabel key={idx} point={p} index={idx} total={data.points.length} />
          ))}
        </div>
      )}

      {/* 스팟 모드 하단 */}
      {isMapReady && viewMode === "spot" && (
        <div style={{ padding: "14px 20px", backgroundColor: "#0D0D16", borderTop: "1px solid rgba(255,255,255,0.07)", flexShrink: 0, minHeight: 80 }}>
          {activeSpot === null ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 52, gap: 4 }}>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>마커를 탭하면 해당 스팟 정보를 볼 수 있어요</p>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.2)" }}>총 {data.points.length}개 스팟</p>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 13, color: "white", fontWeight: 600 }}>
                  {activeSpot === 0 ? "S" : activeSpot === data.points.length - 1 ? "E" : activeSpot + 1}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SpotDetail point={data.points[activeSpot]} index={activeSpot} total={data.points.length} photoUrls={photoUrls} />
              </div>
              <button onClick={() => setActiveSpot(null)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", padding: 4, flexShrink: 0 }}>
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};


// ── 사진 뷰어 (풀스크린) ──
const PhotoViewer = ({ photos, initialIndex, onClose }) => {
  const [current, setCurrent] = React.useState(initialIndex);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 99999, backgroundColor: "rgba(0,0,0,0.95)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>{current + 1} / {photos.length}</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer" }}>
          <X size={22} />
        </button>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
        <img src={photos[current]} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        {photos.length > 1 && (
          <>
            <button
              onClick={() => setCurrent((p) => (p - 1 + photos.length) % photos.length)}
              style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", width: 40, height: 40, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "white", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >‹</button>
            <button
              onClick={() => setCurrent((p) => (p + 1) % photos.length)}
              style={{ position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)", width: 40, height: 40, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "white", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >›</button>
          </>
        )}
      </div>
      {/* 하단 썸네일 스트립 */}
      {photos.length > 1 && (
        <div style={{ padding: "12px 16px", display: "flex", gap: 6, overflowX: "auto", flexShrink: 0, justifyContent: "center" }}>
          {photos.map((url, i) => (
            <div key={i} onClick={() => setCurrent(i)}
              style={{ width: 48, height: 48, borderRadius: 8, overflow: "hidden", flexShrink: 0, cursor: "pointer", border: i === current ? "2px solid #FF6B6B" : "2px solid transparent", transition: "border 0.15s" }}>
              <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── 날짜별 사진 갤러리 ──
const PhotoGallery = ({ photoUrls }) => {
  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [viewerIdx, setViewerIdx] = React.useState(0);
  if (!photoUrls || photoUrls.length === 0) return null;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginTop: 10 }}>
        {photoUrls.slice(0, 6).map((url, i) => (
          <div key={i} onClick={() => { setViewerIdx(i); setViewerOpen(true); }}
            style={{ aspectRatio: "1", borderRadius: 8, overflow: "hidden", cursor: "pointer", position: "relative", backgroundColor: "rgba(255,255,255,0.04)" }}>
            <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            {/* 6장 이상이면 마지막 셀에 +N 배지 */}
            {i === 5 && photoUrls.length > 6 && (
              <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 16, fontWeight: 500, color: "white" }}>+{photoUrls.length - 6}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {viewerOpen && <PhotoViewer photos={photoUrls} initialIndex={viewerIdx} onClose={() => setViewerOpen(false)} />}
    </>
  );
};

// ── 여행 상세 화면 ──
const TripDetailView = ({ trip, visits, onBack, onViewDetail, onDeleteVisit, onDeleteTrip, photoUrlsMap }) => (
  <div style={{ position: "fixed", inset: 0, zIndex: 5000, backgroundColor: "#0A0A0F", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
      <button onClick={onBack} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}>
        <ArrowLeft size={18} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Trip</p>
        <h3 style={{ fontSize: 15, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trip.title}</h3>
      </div>
      <button onClick={() => onDeleteTrip(trip.id)} style={{ padding: "6px 10px", borderRadius: 10, backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.3)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
        <Trash2 size={13} /> 삭제
      </button>
    </div>
    <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
      <Calendar size={14} style={{ color: "rgba(255,255,255,0.3)" }} />
      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>{trip.started_at} ~ {trip.ended_at}</span>
      <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,255,255,0.25)" }}>총 {visits.length}일</span>
    </div>
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
      {visits.length === 0 ? (
        <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", padding: "40px 0", fontStyle: "italic" }}>기록이 없어요</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visits.map((visit, idx) => (
            <div key={visit.id} style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 16, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", backgroundColor: "rgba(255,107,107,0.15)", border: "1px solid rgba(255,107,107,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 10, color: "#FF6B6B", fontWeight: 600 }}>Day {idx + 1}</span>
                </div>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{visit.date}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,107,107,0.6)" }}>📍 {visit.regionName}</span>
              </div>
              {/* 사진 갤러리 */}
              {photoUrlsMap && photoUrlsMap[visit.id] && photoUrlsMap[visit.id].length > 0 && (
                <div style={{ padding: "0 16px 12px" }}>
                  <PhotoGallery photoUrls={photoUrlsMap[visit.id]} />
                </div>
              )}
              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>
                  {visit.points.length > 0 ? `${visit.points.length}곳 방문` : "위치 정보 없음"}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => onDeleteVisit(visit.id)} style={{ padding: "6px 10px", borderRadius: 8, backgroundColor: "transparent", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.25)", cursor: "pointer", display: "flex", alignItems: "center" }}>
                    <Trash2 size={12} />
                  </button>
                  <button onClick={() => onViewDetail(visit)} style={{ padding: "6px 14px", borderRadius: 8, backgroundColor: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", color: "#FF6B6B", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
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

// ── 메인 앱 ──
const SpotLog = ({ user, couple, onLogout }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [uploadStep, setUploadStep] = useState(0);
  const [previewFile, setPreviewFile] = useState(null);
  const [pendingGroups, setPendingGroups] = useState([]);
  const [allUploadedFiles, setAllUploadedFiles] = useState([]); // Storage 업로드용 원본 파일
  const [tripTitle, setTripTitle] = useState("");
  const [viewDetail, setViewDetail] = useState(null);
  const [viewTrip, setViewTrip] = useState(null);
  const [filterYear, setFilterYear] = useState("전체");
  const [trips, setTrips] = useState([]);
  const [visits, setVisits] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [photoUrlsMap, setPhotoUrlsMap] = useState({}); // visitId → URL[]

  const fetchAll = async () => {
    const [{ data: tripsData }, { data: visitsData }] = await Promise.all([
      supabase.from("trips").select("*").eq("couple_id", couple.id).order("started_at", { ascending: false }),
      supabase.from("visits").select("*").eq("couple_id", couple.id).order("date", { ascending: true }),
    ]);
    setTrips(tripsData || []);
    setVisits((visitsData || []).map((r) => ({ id: r.id, tripId: r.trip_id, regionName: r.region_name, date: r.date, points: r.points })));
    // photoUrlsMap 구성
    const urlMap = {};
    (visitsData || []).forEach((r) => { if (r.photo_urls && r.photo_urls.length > 0) urlMap[r.id] = r.photo_urls; });
    setPhotoUrlsMap(urlMap);
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
  const visitedNames = [...new Set(visits.map((v) => v.regionName))];
  const getVisitsForTrip = (tripId) => visits.filter((v) => v.tripId === tripId);
  const years = ["전체", ...new Set(trips.map((t) => t.started_at.split(".")[0]))].reverse();
  const filteredTrips = filterYear === "전체" ? trips : trips.filter((t) => t.started_at.startsWith(filterYear));

  // ✅ 버그 3 수정: 여행 보기 — tripId 기준으로 찾고, 없으면 regionName으로 fallback
  const handleViewTrip = (regionName) => {
    // 해당 지역의 visit 중 tripId가 있는 것 먼저 찾기
    const relatedVisit = visits.find((v) => v.regionName === regionName && v.tripId);
    if (relatedVisit) {
      const trip = trips.find((t) => t.id === relatedVisit.tripId);
      if (trip) { setViewTrip(trip); return; }
    }
    // tripId로 못 찾으면 regionName이 포함된 trip 검색
    for (const trip of trips) {
      const tripVisits = getVisitsForTrip(trip.id);
      if (tripVisits.some((v) => v.regionName === regionName)) {
        setViewTrip(trip);
        return;
      }
    }
  };

  // ... 기존 코드 상단 ...

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setPreviewFile(URL.createObjectURL(files[0]));
    setAllUploadedFiles(files);
    setUploadStep(1);

    try {
      const points = await extractPointsFromFiles(files);
      if (points.length === 0) { setUploadStep(4); return; }
      const groups = groupPointsByDate(points);

      // 초기 그룹 설정 (weather 필드 추가)
      const initialGroups = groups.map((g) => ({
        ...g,
        regionName: null,
        weather: null,
        files: files.filter((f) => {  // 해당 날짜 파일만 매핑
          if (!f) return false;
          try {
            const t = g.points.map(p => p.fileName);
            return t.includes(f.name);
          } catch { return false; }
        }),
        analyzing: true
      }));
      setPendingGroups(initialGroups);
      setUploadStep(2);

      const kakaoReady = await waitForKakao(3000);
      if (kakaoReady) {
        for (let i = 0; i < groups.length; i++) {
          // 1. 지역명 분석
          const { regionName, points: dominantPoints } = await getDominantRegionAndPoints(groups[i].points);

          let weatherInfo = null;
          if (regionName) {
            try {
              // 2. 파이썬 서버로 날씨 크롤링 요청
              const response = await fetch("http://localhost:8000/get-weather", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  date: groups[i].dateKey, // "2026-04-14"
                  location: regionName.split(" ")[0] // "서울" 등 앞글자만 전송
                }),
              });
              const weatherData = await response.json();
              if (weatherData.status === "success") {
                weatherInfo = `${weatherData.weather} (${weatherData.temperature})`;
              }
            } catch (err) {
              console.error("날씨 정보 호출 실패:", err);
            }
          }

          // 3. 상태 업데이트 (지역명 + 날씨)
          setPendingGroups((prev) =>
            prev.map((g, idx) =>
              idx === i ? { ...g, regionName: regionName || null, weather: weatherInfo, dominantPoints, analyzing: false } : g
            )
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

  // ... 기존 코드 하단 ...

  const handleSave = async () => {
    const title = tripTitle.trim() || "우리의 여행";
    const dates = pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort();
    const startedAt = dates[0] || formatDate(new Date());
    const endedAt = dates[dates.length - 1] || startedAt;

    const { data: tripData, error: tripError } = await supabase.from("trips").insert({
      couple_id: couple.id,
      title,
      started_at: startedAt,
      ended_at: endedAt
    }).select().single();

    if (tripError) { alert("저장에 실패했어요."); return; }

    // ✅ 이 부분이 핵심입니다! rows를 만들 때 weather_info를 추가하세요.
    // 날짜별로 사진을 Storage에 업로드
    const groupsWithPhotos = await Promise.all(
      pendingGroups.map(async (group) => {
        const dateKey = group.date ? getDateKey(group.date) : "unknown";
        // 해당 날짜 포인트의 파일명 목록
        const dateFileNames = new Set((group.dominantPoints || group.points).map(p => p.fileName).filter(Boolean));
        const dateFiles = allUploadedFiles.filter(f => dateFileNames.has(f.name));
        let photoUrls = [];
        if (dateFiles.length > 0) {
          photoUrls = await uploadPhotosToStorage(dateFiles, couple.id, dateKey);
        }
        return { ...group, photoUrls };
      })
    );

    const rows = groupsWithPhotos.map((group) => ({
      couple_id: couple.id,
      trip_id: tripData.id,
      region_name: group.regionName || selectedRegion || "알 수 없는 지역",
      date: group.date ? formatDate(group.date) : formatDate(new Date()),
      points: group.dominantPoints || group.points,
      weather_info: group.weather,
      photo_urls: group.photoUrls,
    }));

    const { error: visitsError } = await supabase.from("visits").insert(rows);
    if (visitsError) { alert("저장에 실패했어요."); return; }

    closeModal();
  };

  const handleSaveWithSelectedRegion = async () => {
    if (!selectedRegion) return;
    const title = tripTitle.trim() || selectedRegion;
    const today = formatDate(new Date());
    const { data: tripData, error } = await supabase.from("trips").insert({ couple_id: couple.id, title, started_at: today, ended_at: today }).select().single();
    if (error) { alert("저장에 실패했어요."); return; }
    await supabase.from("visits").insert([{ couple_id: couple.id, trip_id: tripData.id, region_name: selectedRegion, date: today, points: [] }]);
    closeModal();
  };

  const deleteTrip = async (tripId) => {
    if (!window.confirm("이 여행 전체를 삭제할까요?")) return;
    await supabase.from("trips").delete().eq("id", tripId);
    setViewTrip(null);
  };

  const deleteVisit = async (visitId) => {
    if (!window.confirm("이 날의 기록을 삭제할까요?")) return;
    await supabase.from("visits").delete().eq("id", visitId);
  };

  const closeModal = () => {
    setModalOpen(false);
    setUploadStep(0);
    setPreviewFile(null);
    setPendingGroups([]);
    setAllUploadedFiles([]);
    setTripTitle("");
  };

  const isAnalyzing = pendingGroups.some((g) => g.analyzing);
  const currentTripVisits = viewTrip ? getVisitsForTrip(viewTrip.id) : [];

  return (
    <div className="w-full max-w-screen-xl mx-auto h-screen flex flex-col overflow-hidden relative" style={{ backgroundColor: "#0A0A0F", colorScheme: "dark" }}>
      {viewDetail && (
        <KakaoDetailMap
          data={viewDetail}
          onBack={() => setViewDetail(null)}
          photoUrls={photoUrlsMap[viewDetail.id] || []}
        />
      )}
      {viewTrip && !viewDetail && (
        <TripDetailView trip={viewTrip} visits={currentTripVisits} onBack={() => setViewTrip(null)}
          onViewDetail={(v) => setViewDetail(v)} onDeleteVisit={deleteVisit} onDeleteTrip={deleteTrip} photoUrlsMap={photoUrlsMap} />
      )}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 pointer-events-none z-0" style={{ width: 600, height: 240, background: "radial-gradient(ellipse, rgba(255,107,107,0.07) 0%, transparent 70%)", filter: "blur(40px)" }} />

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

      <main className="flex-1 pt-[72px] pb-4 px-4 flex flex-col gap-3 relative z-10 overflow-hidden">
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
                <button onClick={() => handleViewTrip(selectedRegion)} className="rounded-xl"
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, cursor: "pointer" }}>
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
            <div className="flex-1 overflow-y-auto px-4 py-4" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredTrips.map((trip) => {
                const tripVisits = getVisitsForTrip(trip.id);
                return (
                  <div key={trip.id} onClick={() => { setViewTrip(trip); setDrawerOpen(false); }} className="rounded-xl cursor-pointer"
                    style={{ padding: 14, backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", transition: "border-color 0.2s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,107,107,0.2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)")}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <p style={{ fontSize: 14, fontWeight: 500, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{trip.title}</p>
                      <ChevronRight size={14} style={{ color: "rgba(255,255,255,0.25)", flexShrink: 0 }} />
                    </div>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>
                      {trip.started_at === trip.ended_at ? trip.started_at : `${trip.started_at} ~ ${trip.ended_at}`}
                    </p>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[...new Set(tripVisits.map((v) => v.regionName))].slice(0, 3).map((r) => (
                        <span key={r} style={{ fontSize: 10, color: "rgba(255,107,107,0.7)", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)", borderRadius: 6, padding: "2px 8px" }}>{r}</span>
                      ))}
                      {new Set(tripVisits.map((v) => v.regionName)).size > 3 && (
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", padding: "2px 4px" }}>+{new Set(tripVisits.map((v) => v.regionName)).size - 3}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredTrips.length === 0 && <p style={{ textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", padding: "40px 0", fontStyle: "italic" }}>기록이 없어요</p>}
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
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 6 }}>여행 이름 짓기</h3>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 20 }}>{pendingGroups.length}일치 사진이 감지됐어요!</p>
                <div style={{ position: "relative", marginBottom: 16 }}>
                  <Pencil size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
                  <input type="text" placeholder="예: 경주 벚꽃 여행 🌸" value={tripTitle} onChange={(e) => setTripTitle(e.target.value)} maxLength={30}
                    style={{ width: "100%", padding: "12px 16px 12px 40px", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(255,107,107,0.4)")}
                    onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                    autoFocus />
                </div>
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
                <button onClick={() => setUploadStep(3)} style={{ width: "100%", padding: 14, backgroundColor: "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", borderRadius: 12, cursor: "pointer" }}>
                  다음
                </button>
              </>
            )}

            {/* STEP 3: 최종 확인 및 날씨 표시 */}
            {uploadStep === 3 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <button onClick={() => setUploadStep(2)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: 0 }}><ArrowLeft size={16} /></button>
                  <h3 style={{ fontSize: 16, fontWeight: 500, color: "white" }}>저장 확인</h3>
                  {isAnalyzing && (
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <Loader2 size={13} className="animate-spin" style={{ color: "#FF6B6B" }} />
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>분석 중</span>
                    </div>
                  )}
                </div>
                <div style={{ padding: "14px 16px", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 14, marginBottom: 12 }}>
                  <p style={{ fontSize: 11, color: "rgba(255,107,107,0.5)", marginBottom: 4 }}>여행 이름</p>
                  <p style={{ fontSize: 16, fontWeight: 500, color: "#FF6B6B" }}>{tripTitle.trim() || "우리의 여행"}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, maxHeight: 200, overflowY: "auto" }}>
                  {pendingGroups.map((group, idx) => (
                    <div key={idx} style={{ padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: "white", fontWeight: 600 }}>{idx + 1}</span>
                      </div>
                      <span style={{ flex: 1, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{group.date ? formatDate(group.date) : "날짜 미상"}</span>
                      {group.analyzing ? (
                        <Loader2 size={11} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                          <span style={{ fontSize: 12, color: "#FF6B6B" }}>{group.regionName || "지역 미상"}</span>
                          {/* 파이썬 크롤링 서버에서 가져온 날씨 표시 */}
                          {group.weather && (
                            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{group.weather}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button onClick={handleSave} disabled={isAnalyzing} className="w-full rounded-xl"
                  style={{ padding: 14, backgroundColor: isAnalyzing ? "rgba(255,107,107,0.4)" : "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", cursor: isAnalyzing ? "not-allowed" : "pointer" }}>
                  {isAnalyzing ? "분석 완료 후 저장 가능" : "저장하기"}
                </button>
              </>
            )}

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
                      <button onClick={() => setUploadStep(0)} className="rounded-xl" style={{ flex: 1, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>다시 선택</button>
                      <button onClick={handleSaveWithSelectedRegion} className="rounded-xl" style={{ flex: 1, padding: 12, backgroundColor: "#FF6B6B", color: "white", fontSize: 13, fontWeight: 500, border: "none", cursor: "pointer" }}>{selectedRegion} 저장</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <button onClick={() => setUploadStep(0)} className="rounded-xl" style={{ flex: 1, padding: 12, backgroundColor: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", fontSize: 13, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}>다시 선택</button>
                    <button onClick={closeModal} className="rounded-xl" style={{ flex: 1, padding: 12, backgroundColor: "transparent", color: "rgba(255,255,255,0.4)", fontSize: 13, border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}>닫기</button>
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
