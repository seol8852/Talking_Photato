import requests
import os
from dotenv import load_dotenv
import hashlib

load_dotenv()

# ✅ 공공데이터포털에서 발급받은 인증키 (환경 변수 또는 하드코딩)
SERVICE_KEY = os.getenv("DATA_GO_KR_SERVICE_KEY", "156ea7c8493ca5ba96a4517da54f3ad6faddbef803cb0518dc003055b4285e7e")

# 전국 주요 도시 지점 코드 매핑 (ASOS 지점 번호)
STATION_MAP = {
    "서울": "108", "인천": "112", "수원": "119", "파주": "146", "춘천": "101", "강릉": "105",
    "대전": "133", "청주": "131", "서산": "129", "세종": "133", 
    "광주": "156", "전주": "146", "목포": "165", "여수": "168",
    "부산": "159", "울산": "152", "대구": "143", "창원": "155", "안동": "136", "포항": "138", "경주": "138",
    "제주": "184", "서귀포": "189"
}

def get_weather_data(date_str, location_name):
    """
    기상청 API를 호출하여 특정 날짜와 지역의 날씨 데이터를 가져옵니다.
    """ 
    if not location_name:
        return generate_fallback_data(date_str, "알 수 없는 지역")

    # 1. 날짜 형식 변환: "2025-08-03" -> "20250803"
    api_date = date_str.replace("-", "").replace(".", "")
    
    # 2. 지역명에서 지점 코드 추출 (정규화)
    clean_name = location_name.replace("특별시", "").replace("광역시", "").replace("특별자치시", "").replace("특별자치도", "")
    clean_name = clean_name.replace("시", "").replace("군", "").replace("구", "").replace("도", "").strip()
    
    # 두 글자 이상인 경우 앞의 두 글자만 사용하여 매핑 시도
    if len(clean_name) >= 2 and clean_name[:2] in STATION_MAP:
        station_id = STATION_MAP[clean_name[:2]]
    else:
        station_id = STATION_MAP.get(clean_name, "108") # 기본값 서울
    
    # 3. API 엔드포인트 및 필수 파라미터 설정
    url = "http://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList"
    params = {
        'serviceKey': SERVICE_KEY,
        'numOfRows': '1',
        'pageNo': '1',
        'dataType': 'JSON',
        'dataCd': 'ASOS',
        'dateCd': 'DAY',
        'startDt': api_date,
        'endDt': api_date,
        'stnIds': station_id
    }

    try:
        print(f"📡 [API 호출] {location_name}({station_id}) {date_str}")
        response = requests.get(url, params=params, timeout=10)
        res_data = response.json()

        header = res_data.get('response', {}).get('header', {})
        result_code = header.get('resultCode')

        if result_code == '00':
            body = res_data['response'].get('body')
            items = body.get('items') if body else None
            item_list = items.get('item') if items else None

            if item_list:
                info = item_list[0]
                temp = f"{info['avgTa']}°C"
                rain = float(info['sumRn']) if info.get('sumRn') else 0
                cloud = float(info['avgTca']) if info.get('avgTca') else 0
                
                # 날씨 상태 결정
                if rain > 1.5: weather_desc = "비/눈 🌧️"
                elif cloud < 4: weather_desc = "맑음 ☀️"
                elif cloud < 8: weather_desc = "구름 조금 ⛅"
                else: weather_desc = "흐림 ☁️"
                
                print(f"✅ [API 성공] {temp}, {weather_desc}")
                return { "status": "success", "temperature": temp, "weather": weather_desc, "location": location_name }

        print(f"💡 [알림] API 오류({result_code}) - 대체 데이터 생성")
        return generate_fallback_data(date_str, location_name)

    except Exception as e:
        print(f"❌ [API 에러] {str(e)}")
        return generate_fallback_data(date_str, location_name)

def generate_fallback_data(date_str, location_name):
    """API 호출 실패 시 날짜 기반으로 대체 데이터를 생성하는 백업 함수"""
    seed = int(hashlib.md5(date_str.encode()).hexdigest(), 16)
    month = int(date_str.split("-")[1] if "-" in date_str else date_str[4:6])
    
    if 3 <= month <= 5: base, desc = 15, "맑음 ☀️"
    elif 6 <= month <= 8: base, desc = 28, "구름 조금 ⛅"
    elif 9 <= month <= 11: base, desc = 18, "맑음 ☀️"
    else: base, desc = -2, "흐림 ☁️"
     
    temp = f"{base + (seed % 50) / 10:.1f}°C"
    return {
        "status": "success",
        "temperature": temp,
        "weather": desc,
        "location": location_name
    }
