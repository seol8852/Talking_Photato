import React, { useState, useEffect } from "react";
import { Menu, X, Plus, MapPin, Heart, Upload, Loader2, Trash2, ArrowLeft, Check, AlertCircle, LogOut, ChevronRight, Calendar, Pencil, Image as ImageIcon, Map as MapIcon, MessageCircle, Send } from "lucide-react";
import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import { Map, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import * as exifr from "exifr";
import imageCompression from "browser-image-compression";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

// ── 업로드 로직 (이미지 압축 + Supabase 스토리지) ──
const extractPointsFromFiles = async (files, coupleId) => {
  const results = [];
  for (const file of files) {
    try {
      const exif = await exifr.parse(file, {
        gps: true, tiff: true, exif: true,
        pick: ["latitude", "longitude", "DateTimeOriginal"],
      });

      let photo_url = null;
      let uploadErrorMsg = null;

      if (coupleId) {
        try {
          const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1200, useWebWorker: true };
          const compressed = await imageCompression(file, options);
          const ext = file.name.split('.').pop() || "jpg";
          const safeName = `${Date.now()}_${Math.random().toString(36).substring(2,8)}.${ext}`;
          const filePath = `${coupleId}/${safeName}`;

          const { error } = await supabase.storage.from("trip-photos").upload(filePath, compressed);

          if (error) {
            uploadErrorMsg = error.message;
            console.error("스토리지 업로드 에러:", error);
          } else {
            const { data: pubData } = supabase.storage.from("trip-photos").getPublicUrl(filePath);
            photo_url = pubData.publicUrl;
          }
        } catch (e) {
          uploadErrorMsg = e.message;
          console.warn("업로드 로직 실패:", e);
        }
      }

      if (uploadErrorMsg) {
        alert(`사진 업로드에 실패했습니다. Supabase 스토리지에 'trip-photos'라는 이름의 버킷 권한(RLS)이 풀려있는지 확인해 주세요.\n\n상세 에러: ${uploadErrorMsg}`);
      }

      results.push({
        lat: exif?.latitude || null,
        lng: exif?.longitude || null,
        time: exif?.DateTimeOriginal || null,
        fileName: file.name,
        photo_url: photo_url
      });

    } catch (err) {
      console.warn(`EXIF 파싱 실패: ${file.name}`, err);
      let photo_url = null;
      if (coupleId) {
         try {
            const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1200, useWebWorker: true };
            const compressed = await imageCompression(file, options);
            const ext = file.name.split('.').pop() || "jpg";
            const filePath = `${coupleId}/${Date.now()}_${Math.random().toString(36).substring(2,8)}.${ext}`;
            const { error } = await supabase.storage.from("trip-photos").upload(filePath, compressed);
            if (!error) {
              const { data: pubData } = supabase.storage.from("trip-photos").getPublicUrl(filePath);
              photo_url = pubData.publicUrl;
            }
         } catch(e) {}
      }
      results.push({ lat: null, lng: null, time: null, fileName: file.name, photo_url });
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
    if (lat == null || lng == null) { resolve(null); return; }
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
    if (p.lat == null || p.lng == null) continue;
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
      if (window.kakao && window.kakao.maps) { clearInterval(check); window.kakao.maps.load(() => resolve(true)); }
    }, 100);
  });
};

const COMPLEX_KEYWORDS = ["백화점", "아울렛", "쇼핑몰", "몰", "마트", "이마트", "롯데마트", "홈플러스",
                            "놀이공원", "테마파크", "워터파크", "동물원", "식물원", "수족관",
                            "공항", "터미널", "역", "항구",
                            "대학교", "대학", "캠퍼스",
                            "병원", "의료원",
                            "호텔", "리조트", "펜션",
                            "경기장", "야구장", "축구장", "체육관",
                            "박물관", "미술관", "과학관", "도서관",
                            "공원", "광장", "해수욕장", "해변"];

const getPlaceInfo = (lat, lng) => {
  return new Promise((resolve) => {
    if (lat == null || lng == null) { resolve({ placeName: null, address: null, isNearby: false }); return; }
    if (!window.kakao?.maps?.services) {
      resolve({ placeName: null, address: null, isNearby: false });
      return;
    }
    const { kakao } = window;
    const ps = new kakao.maps.services.Places();
    const geocoder = new kakao.maps.services.Geocoder();
    const latlng = new kakao.maps.LatLng(lat, lng);

    const getAddress = () => new Promise((res) => {
      geocoder.coord2Address(lng, lat, (result, status) => {
        if (status !== kakao.maps.services.Status.OK || !result[0]) { res(null); return; }
        const r = result[0];
        const addr = r.road_address
          ? `${r.road_address.region_2depth_name} ${r.road_address.road_name}`
          : `${r.address.region_2depth_name} ${r.address.sub_locality || r.address.region_3depth_name}`;
        res(addr || null);
      });
    });

    const searchPlaces = (radius) => new Promise((res) => {
      ps.keywordSearch(" ", (result, status) => {
        if (status === kakao.maps.services.Status.OK && result?.length > 0) {
          const sorted = [...result].sort((a, b) => Number(a.distance) - Number(b.distance));
          res(sorted[0]);
        } else {
          res(null);
        }
      }, { location: latlng, radius, sort: kakao.maps.services.SortBy.DISTANCE });
    });

    Promise.all([searchPlaces(50), getAddress()]).then(async ([place50, address]) => {
      const bestPlace = place50 || (await searchPlaces(200));
      if (!bestPlace) {
        resolve({ placeName: null, address, isNearby: false });
        return;
      }
      const isNearby = COMPLEX_KEYWORDS.some((kw) => bestPlace.place_name.includes(kw));
      resolve({ placeName: bestPlace.place_name, address, isNearby });
    });
  });
};

const PointCard = ({ point, index, total }) => {
  const [placeInfo, setPlaceInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (point.lat == null || point.lng == null) {
      setLoading(false);
      return;
    }
    getPlaceInfo(point.lat, point.lng).then((info) => {
      setPlaceInfo(info);
      setLoading(false);
    });
  }, [point.lat, point.lng]);

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const label = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `📍 ${index + 1}`;

  return (
    <div style={{ flexShrink: 0, padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, minWidth: 140, maxWidth: 200 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "#FF6B6B" }}>{label}</span>
        {point.time && (
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>
            {new Date(point.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Loader2 size={11} className="animate-spin" style={{ color: "rgba(255,255,255,0.3)" }} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>조회 중...</span>
        </div>
      ) : placeInfo?.placeName ? (
        <>
          <p style={{ fontSize: 12, fontWeight: 500, color: "white", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {placeInfo.placeName}{placeInfo.isNearby ? " 근처" : ""}
          </p>
          {placeInfo.address && (
            <p style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {placeInfo.address}
            </p>
          )}
        </>
      ) : placeInfo?.address ? (
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {placeInfo.address}
        </p>
      ) : point.lat != null && point.lng != null ? (
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
          {point.lat.toFixed(4)}, {point.lng.toFixed(4)}
        </p>
      ) : (
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>위치 정보 없음</p>
      )}
    </div>
  );
};

// ── 카카오 상세 지도 (react-kakao-maps-sdk 기반) ──
const KakaoDetailMap = ({ data, onBack, onUpdateVisit }) => {
  const [isMapReady, setIsMapReady] = useState(false);
  const [selectedPointIndex, setSelectedPointIndex] = useState(null);

  const [memoText, setMemoText] = useState("");
  const [isEditingMemo, setIsEditingMemo] = useState(false);

  const mapPoints = data.points ? data.points.filter(p => p.lat != null && p.lng != null) : [];
  const selectedPoint = selectedPointIndex !== null ? mapPoints[selectedPointIndex] : null;

  useEffect(() => {
    let attempts = 0;
    const checkKakao = setInterval(() => {
      attempts++;
      if (attempts > 50) { clearInterval(checkKakao); return; }
      if (window.kakao && window.kakao.maps) {
        clearInterval(checkKakao);
        window.kakao.maps.load(() => setIsMapReady(true));
      }
    }, 100);
    return () => clearInterval(checkKakao);
  }, []);

  useEffect(() => {
    if (selectedPoint) {
       setMemoText(selectedPoint.memo || "");
       setIsEditingMemo(false);
    }
  }, [selectedPointIndex]);

  const handleSaveMemo = () => {
    if (selectedPointIndex === null) return;
    const actualPoint = mapPoints[selectedPointIndex];

    // 원본 data.points 배열에서 해당 포인트의 메모를 업데이트
    const updatedPoints = data.points.map(p =>
       p === actualPoint ? { ...p, memo: memoText } : p
    );

    if (onUpdateVisit) {
        onUpdateVisit(data.id, updatedPoints);
    }
    setIsEditingMemo(false);
  };

  if (!mapPoints || mapPoints.length === 0) {
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
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", lineHeight: 1.7 }}>이 날의 사진들은 GPS 정보가 없어<br />지도에 동선을 표시할 수 없어요</p>
          </div>
        </div>
      </div>
    );
  }

  const bounds = isMapReady ? new window.kakao.maps.LatLngBounds() : null;
  if (isMapReady) {
    mapPoints.forEach((p) => bounds.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
  }

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
          <span style={{ fontSize: 12, color: "#FF6B6B" }}>📍 {mapPoints.length}곳</span>
        </div>
      </div>

      <div style={{ flex: 1, position: "relative" }}>
        {!isMapReady && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "#0A0A0F", zIndex: 10 }}>
            <Loader2 className="animate-spin" size={36} color="#FF6B6B" />
          </div>
        )}

        {isMapReady && (
          <Map
            center={{ lat: mapPoints[0].lat, lng: mapPoints[0].lng }}
            style={{ width: "100%", height: "100%" }}
            level={4}
            onCreate={(map) => { if (bounds && mapPoints.length > 1) map.setBounds(bounds, 80); }}
          >
            <Polyline
              path={mapPoints.map(p => ({ lat: p.lat, lng: p.lng }))}
              strokeWeight={5} strokeColor="#FF6B6B" strokeOpacity={0.85} strokeStyle="solid"
            />
            {mapPoints.map((pos, idx) => {
              const isFirst = idx === 0, isLast = idx === mapPoints.length - 1;
              const label = isFirst ? "🚀 출발" : isLast ? "🏁 도착" : `${idx + 1}`;
              const isSelected = selectedPointIndex === idx;
              return (
                <CustomOverlayMap key={idx} position={{ lat: pos.lat, lng: pos.lng }} yAnchor={1} zIndex={isSelected ? 10 : 1}>
                  <div
                    onClick={() => setSelectedPointIndex(isSelected ? null : idx)}
                    style={{
                      background: isSelected ? "white" : "#FF6B6B",
                      color: isSelected ? "#FF6B6B" : "white",
                      padding: "5px 11px", borderRadius: "20px", fontSize: "12px", fontWeight: "600",
                      border: "2px solid rgba(255,255,255,0.9)", boxShadow: "0 3px 10px rgba(0,0,0,0.35)",
                      whiteSpace: "nowrap", cursor: "pointer", transition: "all 0.2s"
                    }}
                  >
                    {label}
                  </div>
                </CustomOverlayMap>
              );
            })}
          </Map>
        )}

        {/* 사진 팝업(오버레이) UI */}
        {selectedPoint && (
          <div style={{ position: "absolute", bottom: 20, left: 20, right: 20, backgroundColor: "rgba(20,20,25,0.95)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: 16, zIndex: 100, boxShadow: "0 10px 40px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => setSelectedPointIndex(null)} style={{ position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,0.1)", border: "none", color: "white", borderRadius: "50%", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={14}/></button>

            <div style={{ display: "flex", gap: 12 }}>
                <div style={{ width: 80, height: 80, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", overflow: "hidden", flexShrink: 0 }}>
                  {selectedPoint.photo_url ? (
                    <img src={selectedPoint.photo_url} alt="spot" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.2)" }}><ImageIcon size={24}/></div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 24 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: "white", marginBottom: 4 }}>
                     {selectedPoint.time ? new Date(selectedPoint.time).toLocaleTimeString("ko-KR", { hour: '2-digit', minute: '2-digit' }) : "시간 미상"}의 기록
                  </p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selectedPoint.lat.toFixed(4)}, {selectedPoint.lng.toFixed(4)}
                  </p>
                </div>
            </div>

            {/* 메모 입력 영역 */}
            <div style={{ backgroundColor: "rgba(255,255,255,0.03)", borderRadius: 12, padding: "10px 12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                {isEditingMemo ? (
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            type="text"
                            value={memoText}
                            onChange={(e) => setMemoText(e.target.value)}
                            placeholder="이곳에서의 추억을 남겨보세요..."
                            autoFocus
                            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "white", fontSize: 12 }}
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveMemo()}
                        />
                        <button onClick={handleSaveMemo} style={{ background: "#FF6B6B", border: "none", borderRadius: 8, color: "white", padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 500 }}>저장</button>
                    </div>
                ) : (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <p style={{ fontSize: 12, color: selectedPoint.memo ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)", lineHeight: 1.5, wordBreak: "break-word", margin: 0 }}>
                            {selectedPoint.memo || "이곳에서의 추억을 남겨보세요..."}
                        </p>
                        <button onClick={() => setIsEditingMemo(true)} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: 2, display: "flex", flexShrink: 0 }}>
                            <Pencil size={12} />
                        </button>
                    </div>
                )}
            </div>
          </div>
        )}
      </div>

      {isMapReady && (
        <div style={{ padding: "12px 16px", backgroundColor: "#0D0D16", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 8, overflowX: "auto", flexShrink: 0 }}>
          {mapPoints.map((p, idx) => (
            <PointCard key={idx} point={p} index={idx} total={mapPoints.length} />
          ))}
        </div>
      )}
    </div>
  );
};

// ── 날씨 정보 컴포넌트 (백엔드 API 연동) ──
const WeatherBadge = ({ date, location }) => {
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const response = await fetch("http://localhost:8000/get-weather", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, location }),
        });
        const data = await response.json();
        if (data.status === "success") {
          setWeather(data);
        }
      } catch (err) {
        console.warn("날씨 API 호출 실패:", err);
      }
    };
    if (date && location) fetchWeather();
  }, [date, location]);

  if (!weather) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", marginLeft: 6 }}>
      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>{weather.temperature}</span>
      <span style={{ fontSize: 11 }}>{weather.weather.includes(" ") ? weather.weather.split(" ")[1] : weather.weather}</span>
    </div>
  );
};

// ── 여행 상세 화면 (핀터레스트 갤러리 피드 추가) ──
const TripDetailView = ({ trip, visits, onBack, onViewDetail, onDeleteVisit, onDeleteTrip }) => {
  const [viewMode, setViewMode] = useState("list");

  const photos = visits.flatMap(v => v.points.map(p => ({ ...p, visitDate: v.date, regionName: v.regionName }))).filter(p => p.photo_url);

  return (
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

      <div style={{ display: "flex", padding: "16px 20px 0", gap: 10 }}>
        <button onClick={() => setViewMode("list")} style={{ flex: 1, padding: "10px", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, fontWeight: 500, backgroundColor: viewMode === "list" ? "rgba(255,107,107,0.15)" : "rgba(255,255,255,0.03)", color: viewMode === "list" ? "#FF6B6B" : "rgba(255,255,255,0.4)", border: `1px solid ${viewMode === "list" ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.08)"}`, transition: "all 0.2s", cursor: "pointer" }}>
          <MapIcon size={16} /> 일정 뷰
        </button>
        <button onClick={() => setViewMode("gallery")} style={{ flex: 1, padding: "10px", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, fontWeight: 500, backgroundColor: viewMode === "gallery" ? "rgba(255,107,107,0.15)" : "rgba(255,255,255,0.03)", color: viewMode === "gallery" ? "#FF6B6B" : "rgba(255,255,255,0.4)", border: `1px solid ${viewMode === "gallery" ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.08)"}`, transition: "all 0.2s", cursor: "pointer" }}>
          <ImageIcon size={16} /> 갤러리 피드
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {viewMode === "list" ? (
          visits.length === 0 ? (
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
                    <WeatherBadge date={visit.date} location={visit.regionName} />
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,107,107,0.6)" }}>📍 {visit.regionName}</span>
                  </div>
                  <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>{visit.points.length > 0 ? `${visit.points.length}곳 방문` : "위치 정보 없음"}</span>
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
          )
        ) : (
          photos.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "rgba(255,255,255,0.3)" }}>
              <ImageIcon size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
              <p style={{ fontSize: 13 }}>업로드된 사진이 없어요</p>
            </div>
          ) : (
            <div style={{ columnCount: 2, columnGap: "12px" }}>
              {photos.map((point, idx) => (
                <div key={idx} style={{ breakInside: "avoid", marginBottom: "12px", position: "relative", borderRadius: 16, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <img src={point.photo_url} alt="memory" style={{ width: "100%", display: "block" }} loading="lazy" />
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "24px 12px 12px", background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)", pointerEvents: "none" }}>
                    <p style={{ color: "white", fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{point.regionName || "위치 정보 없음"}</p>
                    <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 10 }}>{point.time ? new Date(point.time).toLocaleDateString() : ""} {point.time ? new Date(point.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ""}</p>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};

// ── AI 챗봇 컴포넌트 (Gemini API 연동) ──
const ChatBot = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "model", content: "안녕하세요! 커플들을 위한 SpotLog AI 어시스턴트입니다 💖\n어떤 데이트 장소를 찾으시나요? 날씨나 코스 추천 등 무엇이든 편하게 물어보세요!" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextStatus, setContextStatus] = useState("wait"); // "wait", "success", "error"

  // 사용자의 현재 위치 및 날씨 정보 저장
  const [contextInfo, setContextInfo] = useState({ location: null, weather: null });

  useEffect(() => {
    // 챗봇 열릴 때 한 번만 위치와 날씨 정보를 가져옵니다.
    const fetchContextData = async () => {
      const applyFallback = async () => {
        try {
          const fallbackLocation = "서울 강남구";
          const today = new Date();
          const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
          const response = await fetch("http://localhost:8000/get-weather", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: dateStr, location: fallbackLocation }),
          });
          const data = await response.json();
          if (data.status === "success") {
            setContextInfo({
              location: fallbackLocation,
              weather: `${data.temperature}, ${data.weather} (테스트 모드)`
            });
            setContextStatus("success");
          } else {
            setContextStatus("error");
          }
        } catch (error) {
          setContextStatus("error");
        }
      };

      if (isOpen && !contextInfo.location) {
        setContextStatus("wait");
        if (navigator.geolocation) {
          // 카카오맵 SDK 로딩 보장
          await waitForKakao(3000);

          navigator.geolocation.getCurrentPosition(
            async (position) => {
              const { latitude, longitude } = position.coords;
              try {
                // 1. 역지오코딩으로 지역명 획득
                const regionName = await getRegionFromCoords(latitude, longitude);

                if (regionName) {
                  // 2. 현재 날짜 구하기
                  const today = new Date();
                  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

                  // 3. 날씨 API 호출
                  const response = await fetch("http://localhost:8000/get-weather", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ date: dateStr, location: regionName }),
                  });
                  const data = await response.json();

                  if (data.status === "success") {
                    setContextInfo({
                      location: regionName,
                      weather: `${data.temperature}, ${data.weather}`
                    });
                    setContextStatus("success");
                  } else {
                    await applyFallback();
                  }
                } else {
                    await applyFallback();
                }
              } catch (error) {
                console.error("Context Data Fetch Error:", error);
                await applyFallback();
              }
            },
            async (error) => {
              console.warn("Geolocation Error or Timeout:", error);
              // 권한 거부 또는 타임아웃 시 강제 Fallback 적용
              await applyFallback();
            },
            { timeout: 15000, maximumAge: 0 } // 노트북을 위해 타임아웃을 15초로 연장
          );
        } else {
          await applyFallback();
        }
      }
    };

    fetchContextData();
  }, [isOpen]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    const MAX_RETRIES = 5;
    const INITIAL_DELAY_MS = 1000; // 1초

    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        setMessages((prev) => [...prev, { role: "model", content: "⚠️ Gemini API 키가 설정되지 않았습니다. .env 파일을 확인해주세요." }]);
        setLoading(false);
        return;
      }

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      // Context-Aware 프롬프트 구성
      let contextString = "";
      if (contextInfo.location && contextInfo.weather && contextStatus === "success") {
          contextString = `\n\n[필독: 사용자 현재 상황]\n- 현재 위치: ${contextInfo.location}\n- 실시간 날씨: ${contextInfo.weather}\n* 중요: 사용자가 날씨나 위치를 명시하지 않더라도, 위의 실시간 날씨와 위치 정보를 적극적으로 반영하여 이 지역의 날씨에 완벽하게 어울리는 데이트 코스를 추천해 주세요.\n`;
      }

      const prompt = `당신은 한국의 커플들을 위해 로맨틱하고 센스있게 데이트 장소나 코스를 추천해주고, 날씨나 꿀팁을 친절하게 알려주는 AI 어시스턴트입니다. 항상 다정하고 친근한 말투(해요체)를 사용하고, 너무 길지 않게 핵심만 답변해주세요.${contextString}\n사용자 질문: ${userMessage}`;

      let delay = INITIAL_DELAY_MS;
      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const result = await model.generateContent(prompt);
          const response = await result.response;
          const text = response.text();
          setMessages((prev) => [...prev, { role: "model", content: text }]);
          break; // 성공하면 루프 종료
        } catch (err) {
          console.error(`Gemini API Error (Attempt ${i + 1}/${MAX_RETRIES}):`, err);
          if (err.message && err.message.includes("429") && i < MAX_RETRIES - 1) {
            setMessages((prev) => [...prev, { role: "model", content: `API 요청이 너무 많아요. 잠시 후 다시 시도합니다... (재시도 ${i + 1}/${MAX_RETRIES})` }]);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // 딜레이를 두 배로 늘림
          } else {
            setMessages((prev) => [...prev, { role: "model", content: `앗, API 호출에 오류가 발생했어요: ${err.message}` }]);
            break; // 재시도 불가능한 오류 또는 마지막 재시도 실패
          }
        }
      }
    } catch (err) {
      console.error("Gemini API Initialization Error:", err);
      setMessages((prev) => [...prev, { role: "model", content: `챗봇 초기화 중 오류가 발생했어요: ${err.message}` }]);
    }
    setLoading(false);
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9000, width: 56, height: 56, borderRadius: "50%", backgroundColor: "#FF6B6B", color: "white", border: "none", boxShadow: "0 4px 16px rgba(255,107,107,0.4)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.2s", transform: isOpen ? "scale(0.9)" : "scale(1)" }}
      >
        {isOpen ? <X size={24} /> : <MessageCircle size={26} />}
      </button>

      {isOpen && (
        <div style={{ position: "fixed", bottom: 96, right: 24, width: 340, height: 520, backgroundColor: "#16161F", borderRadius: 24, border: "1px solid rgba(255,107,107,0.2)", boxShadow: "0 10px 40px rgba(0,0,0,0.5)", zIndex: 9000, display: "flex", flexDirection: "column", overflow: "hidden", animation: "slideUp 0.3s ease-out" }}>
          <style>{`@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }`}</style>

          <div style={{ padding: "16px 20px", backgroundColor: "rgba(255,107,107,0.1)", borderBottom: "1px solid rgba(255,107,107,0.15)", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Heart size={16} fill="white" color="white" />
            </div>
            <div>
              <span style={{ fontSize: 15, fontWeight: 600, color: "white", display: "block", marginBottom: 2 }}>SpotLog AI</span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>우리만의 데이트 어시스턴트</span>
            </div>
          </div>

          <div style={{ flex: 1, padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", backgroundColor: m.role === "user" ? "#FF6B6B" : "rgba(255,255,255,0.06)", color: m.role === "user" ? "white" : "rgba(255,255,255,0.9)", padding: "12px 16px", borderRadius: m.role === "user" ? "20px 20px 4px 20px" : "20px 20px 20px 4px", maxWidth: "85%", fontSize: 13, lineHeight: 1.6, wordBreak: "break-word", whiteSpace: "pre-wrap", border: m.role === "user" ? "none" : "1px solid rgba(255,255,255,0.08)" }}>
                {m.content}
              </div>
            ))}
            {loading && (
              <div style={{ alignSelf: "flex-start", padding: "12px 16px", backgroundColor: "rgba(255,255,255,0.06)", borderRadius: "20px 20px 20px 4px", border: "1px solid rgba(255,255,255,0.08)" }}>
                <Loader2 size={16} className="animate-spin" style={{ color: "#FF6B6B" }} />
              </div>
            )}
          </div>

          {/* Context-Aware 상태 표시창 추가 */}
          <div style={{ padding: "8px 16px", backgroundColor: "rgba(0,0,0,0.3)", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 6 }}>
             <MapPin size={12} style={{ color: contextStatus === "success" ? "#FF6B6B" : "rgba(255,255,255,0.3)" }} />
             <span style={{ fontSize: 11, color: contextStatus === "success" ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)" }}>
               {contextStatus === "success" ? `${contextInfo.location} · ${contextInfo.weather}` : contextStatus === "error" ? "위치 정보를 가져오는 데 실패했습니다" : "현재 위치와 날씨 파악 중..."}
             </span>
          </div>

          <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", backgroundColor: "rgba(0,0,0,0.2)", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="예: 실내 코스 추천해줘!"
              style={{ flex: 1, padding: "12px 16px", borderRadius: 20, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontSize: 13, outline: "none", transition: "border-color 0.2s" }}
              onFocus={(e) => (e.target.style.borderColor = "rgba(255,107,107,0.4)")}
              onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
            />
            <button onClick={sendMessage} style={{ width: 44, height: 44, borderRadius: "50%", backgroundColor: input.trim() ? "#FF6B6B" : "rgba(255,255,255,0.1)", border: "none", color: "white", display: "flex", alignItems: "center", justifyContent: "center", cursor: input.trim() ? "pointer" : "default", flexShrink: 0, transition: "background-color 0.2s" }}>
              <Send size={18} style={{ transform: "translateX(1px) translateY(1px)" }} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

// ── 메인 앱 ──
const SpotLog = ({ user, couple, onLogout }) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [uploadStep, setUploadStep] = useState(0);
  const [previewFile, setPreviewFile] = useState(null);
  const [pendingGroups, setPendingGroups] = useState([]);
  const [tripTitle, setTripTitle] = useState("");
  const [viewDetail, setViewDetail] = useState(null);
  const [viewTrip, setViewTrip] = useState(null);
  const [filterYear, setFilterYear] = useState("전체");
  const [trips, setTrips] = useState([]);
  const [visits, setVisits] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);

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
  const visitedNames = visits.map((v) => v.regionName);
  const getVisitsForTrip = (tripId) => visits.filter((v) => v.tripId === tripId);
  const years = ["전체", ...new Set(trips.map((t) => t.started_at.split(".")[0]))].reverse();
  const filteredTrips = filterYear === "전체" ? trips : trips.filter((t) => t.started_at.startsWith(filterYear));

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setPreviewFile(URL.createObjectURL(files[0]));
    setUploadStep(1);
    try {
      const points = await extractPointsFromFiles(files, couple.id);

      if (points.length === 0) { setUploadStep(4); return; }

      const groups = groupPointsByDate(points);
      setPendingGroups(groups.map((g) => ({ ...g, regionName: null, dominantPoints: null, totalPoints: g.points.length, analyzing: true })));
      setUploadStep(2);
      const kakaoReady = await waitForKakao(3000);
      if (kakaoReady) {
        for (let i = 0; i < groups.length; i++) {
          const { regionName, points: dominantPoints } = await getDominantRegionAndPoints(groups[i].points);
          setPendingGroups((prev) => prev.map((g, idx) => idx === i ? { ...g, regionName: regionName || null, dominantPoints, analyzing: false } : g));
        }
      } else {
        setPendingGroups((prev) => prev.map((g) => ({ ...g, regionName: null, dominantPoints: g.points, analyzing: false })));
      }
    } catch (err) {
      setUploadStep(4);
    }
  };

  const handleSave = async () => {
    const title = tripTitle.trim() || "우리의 여행";
    const dates = pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort();
    const startedAt = dates[0] || formatDate(new Date());
    const endedAt = dates[dates.length - 1] || startedAt;

    // 1. 여행(trips) 생성
    const { data: tripData, error: tripError } = await supabase
      .from("trips").insert({ couple_id: couple.id, title, started_at: startedAt, ended_at: endedAt })
      .select().single();
    if (tripError) { alert("저장에 실패했어요."); return; }

    // 2. 날짜별로 그룹화하여 데이터 정리 (같은 날짜면 합침)
    const dailyMap = {};
    for (const group of pendingGroups) {
      const dateKey = group.date ? formatDate(group.date) : formatDate(new Date());
      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {
          couple_id: couple.id,
          trip_id: tripData.id,
          region_name: group.regionName || selectedRegion || "알 수 없는 지역",
          date: dateKey,
          points: [],
        };
      }
      // 해당 날짜의 포인트들 합치기
      const newPoints = (group.dominantPoints || group.points).map(p => ({
        ...p,
        regionName: group.regionName // 포인트마다 방문 지역 기록
      }));
      dailyMap[dateKey].points = [...dailyMap[dateKey].points, ...newPoints];
      
      // 지역명이 여러 개일 경우 콤마로 연결하거나 대표 지역 설정
      if (group.regionName && !dailyMap[dateKey].region_name.includes(group.regionName)) {
        if (dailyMap[dateKey].region_name === "알 수 없는 지역" || dailyMap[dateKey].region_name === selectedRegion) {
          dailyMap[dateKey].region_name = group.regionName;
        } else {
          dailyMap[dateKey].region_name += `, ${group.regionName}`;
        }
      }
    }

    const rows = Object.values(dailyMap);

    // 3. 합쳐진 데이터를 한 번에 저장
    const { error } = await supabase.from("visits").insert(rows);
    if (error) { alert("저장에 실패했어요."); return; }
    closeModal();
  };

  const handleSaveWithSelectedRegion = async () => {
    if (!selectedRegion) return;
    const today = formatDate(new Date());
    const { data: tripData, error } = await supabase
      .from("trips").insert({ couple_id: couple.id, title: tripTitle.trim() || selectedRegion, started_at: today, ended_at: today })
      .select().single();
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

  const handleUpdateVisit = async (visitId, updatedPoints) => {
    // 로컬 상태 즉시 업데이트 (Optimistic UI)
    setVisits(prev => prev.map(v => v.id === visitId ? { ...v, points: updatedPoints } : v));
    if (viewDetail && viewDetail.id === visitId) {
      setViewDetail(prev => ({ ...prev, points: updatedPoints }));
    }

    // Supabase DB 업데이트
    const { error } = await supabase.from("visits").update({ points: updatedPoints }).eq("id", visitId);
    if (error) {
      console.error("Memo update failed:", error);
      alert("메모 저장에 실패했습니다.");
    }
  };

  const closeModal = () => {
    setModalOpen(false); setUploadStep(0);
    setPreviewFile(null); setPendingGroups([]); setTripTitle("");
  };

  const isAnalyzing = pendingGroups.some((g) => g.analyzing);
  const currentTripVisits = viewTrip ? getVisitsForTrip(viewTrip.id) : [];

  return (
    <div className="w-full max-w-screen-xl mx-auto h-screen flex flex-col overflow-hidden relative" style={{ backgroundColor: "#0A0A0F", colorScheme: "dark" }}>
      {viewDetail && <KakaoDetailMap data={viewDetail} onBack={() => setViewDetail(null)} onUpdateVisit={handleUpdateVisit} />}
      {viewTrip && !viewDetail && (
        <TripDetailView trip={viewTrip} visits={currentTripVisits} onBack={() => setViewTrip(null)}
          onViewDetail={(v) => setViewDetail(v)} onDeleteVisit={deleteVisit} onDeleteTrip={deleteTrip} />
      )}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 pointer-events-none z-0" style={{ width: 600, height: 240, background: "radial-gradient(ellipse, rgba(255,107,107,0.07) 0%, transparent 70%)", filter: "blur(40px)" }} />

      <header className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-screen-xl z-50 flex items-center justify-between px-5 py-4" style={{ background: "linear-gradient(to bottom, #0A0A0F 60%, transparent)" }}>
        <button onClick={() => setDrawerOpen(true)} className="w-9 h-9 flex items-center justify-center rounded-xl" style={{ backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", cursor: "pointer" }}><Menu size={18} /></button>
        <div className="flex items-center gap-2">
          <Heart size={14} fill="#FF6B6B" color="#FF6B6B" />
          <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: "0.14em", color: "#FF6B6B", textTransform: "uppercase" }}>SpotLog</span>
        </div>
        <button onClick={() => setModalOpen(true)} className="w-9 h-9 flex items-center justify-center rounded-xl" style={{ backgroundColor: "#FF6B6B", color: "white", border: "none", cursor: "pointer", boxShadow: "0 4px 16px rgba(255,107,107,0.3)" }}><Plus size={18} /></button>
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
                <button onClick={() => {
                  const rv = visits.find((v) => v.regionName === selectedRegion);
                  if (rv?.tripId) { const t = trips.find((t) => t.id === rv.tripId); if (t) setViewTrip(t); }
                }} className="rounded-xl" style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.6)", backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", flexShrink: 0, cursor: "pointer" }}>
                  여행 보기
                </button>
              ) : (
                <button onClick={() => setModalOpen(true)} className="rounded-xl" style={{ padding: "8px 16px", fontSize: 12, fontWeight: 500, color: "white", backgroundColor: "#FF6B6B", border: "none", flexShrink: 0, cursor: "pointer" }}>
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

      {drawerOpen && (
        <div className="fixed inset-0 z-[1000] flex">
          <div className="absolute inset-0 backdrop-blur-sm" style={{ backgroundColor: "rgba(0,0,0,0.5)" }} onClick={() => setDrawerOpen(false)} />
          <div className="relative flex flex-col" style={{ width: 280, height: "100%", backgroundColor: "#0D0D16", borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: "#FF6B6B" }}>History</span>
              <button onClick={() => setDrawerOpen(false)} style={{ color: "rgba(255,255,255,0.4)", background: "none", border: "none", cursor: "pointer" }}><X size={18} /></button>
            </div>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyItems: "space-between" }}>
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{user?.email}</p>
              <button onClick={onLogout} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.4)", fontSize: 11, cursor: "pointer" }}>
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
                const tv = getVisitsForTrip(trip.id);
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
                      {[...new Set(tv.map((v) => v.regionName))].slice(0, 3).map((r) => (
                        <span key={r} style={{ fontSize: 10, color: "rgba(255,107,107,0.7)", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.15)", borderRadius: 6, padding: "2px 8px" }}>{r}</span>
                      ))}
                      {new Set(tv.map((v) => v.regionName)).size > 3 && (
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", padding: "2px 4px" }}>+{new Set(tv.map((v) => v.regionName)).size - 3}</span>
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
                  <p style={{ fontSize: 14, fontWeight: 500, color: "white", marginBottom: 4 }}>위치 데이터 분석 및 이미지 압축 중</p>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>사진을 안전하게 클라우드에 저장하고 있어요...</p>
                </div>
              </div>
            )}

            {uploadStep === 2 && (
              <>
                <h3 style={{ fontSize: 16, fontWeight: 500, color: "white", marginBottom: 6 }}>여행 이름 짓기</h3>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 20 }}>{pendingGroups.length}일치 사진이 감지됐어요</p>
                <div style={{ position: "relative", marginBottom: 16 }}>
                  <Pencil size={15} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(255,255,255,0.3)" }} />
                  <input type="text" placeholder="예: 잠실 벚꽃 여행 🌸" value={tripTitle} onChange={(e) => setTripTitle(e.target.value)} maxLength={30} autoFocus
                    style={{ width: "100%", padding: "12px 16px 12px 40px", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(255,107,107,0.4)")}
                    onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                  />
                </div>
                <div style={{ padding: "12px 14px", backgroundColor: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, marginBottom: 20 }}>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>감지된 일정</p>
                  {pendingGroups.map((g, idx) => (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: "rgba(255,107,107,0.6)", minWidth: 40 }}>Day {idx + 1}</span>
                      <span style={{ color: "rgba(255,255,255,0.4)" }}>{g.date ? formatDate(g.date) : "날짜 미상"}</span>
                      {g.analyzing ? (
                        <Loader2 size={10} className="animate-spin" style={{ color: "rgba(255,255,255,0.2)", marginLeft: "auto" }} />
                      ) : (
                        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                          {g.regionName && <WeatherBadge date={formatDate(g.date)} location={g.regionName} />}
                          <span style={{ color: "rgba(255,107,107,0.5)" }}>{g.regionName || "지역 분석 실패"}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button onClick={() => setUploadStep(3)} style={{ width: "100%", padding: 14, backgroundColor: "#FF6B6B", color: "white", fontSize: 14, fontWeight: 500, border: "none", borderRadius: 12, cursor: "pointer" }}>다음</button>
              </>
            )}

            {uploadStep === 3 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <button onClick={() => setUploadStep(2)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", padding: 0 }}><ArrowLeft size={16} /></button>
                  <h3 style={{ fontSize: 16, fontWeight: 500, color: "white" }}>저장 확인</h3>
                  {isAnalyzing && (
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <Loader2 size={13} className="animate-spin" style={{ color: "#FF6B6B" }} />
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>지역 분석 중</span>
                    </div>
                  )}
                </div>
                <div style={{ padding: "14px 16px", backgroundColor: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: 14, marginBottom: 12 }}>
                  <p style={{ fontSize: 11, color: "rgba(255,107,107,0.5)", marginBottom: 4 }}>여행 이름</p>
                  <p style={{ fontSize: 16, fontWeight: 500, color: "#FF6B6B" }}>{tripTitle.trim() || "우리의 여행"}</p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
                    {pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort()[0]} ~{" "}
                    {pendingGroups.filter((g) => g.date).map((g) => formatDate(g.date)).sort().slice(-1)[0]}
                  </p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16, maxHeight: 200, overflowY: "auto" }}>
                  {pendingGroups.map((group, idx) => (
                    <div key={idx} style={{ padding: "10px 14px", backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: "#FF6B6B", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 10, color: "white", fontWeight: 600 }}>{idx + 1}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 2 }}>{group.date ? formatDate(group.date) : "날짜 미상"}</p>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "#FF6B6B", fontWeight: 500 }}>{group.regionName || "지역 미상"}</span>
                          {!group.analyzing && group.regionName && <WeatherBadge date={formatDate(group.date)} location={group.regionName} />}
                        </div>
                      </div>
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

      {/* AI 챗봇 컴포넌트 (우측 하단 플로팅 버튼) */}
      <ChatBot />

      <style>{`* { box-sizing: border-box; } ::-webkit-scrollbar { width: 0; } input::placeholder { color: rgba(255,255,255,0.25); }`}</style>
    </div>
  );
};

export default SpotLog;
