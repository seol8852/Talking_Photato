from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from crawler import get_weather_data # crawler.py 파일이 같은 폴더에 있어야 합니다

app = FastAPI()

# 1. CORS 설정: React와 통신하려면 반드시 따옴표와 ["*"] 설정이 필요합니다
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"], # 따옴표 추가
    allow_credentials=True,
    allow_methods=["*"], # 모든 메서드 허용
    allow_headers=["*"], # 모든 헤더 허용
)

# 2. 데이터 형식 정의: 클래스 끝에 콜론(:) 필수
class WeatherRequest(BaseModel):
    date: str      # 예: "2026-04-14"
    location: str  # 예: "서울"

# 3. API 엔드포인트: 경로에 따옴표와 함수에 콜론(:) 필수
@app.post("/get-weather")
async def fetch_weather(request: WeatherRequest): # 타입 힌트에도 콜론(:) 추가
    # crawler.py의 get_weather_data 함수를 실행합니다
    result = get_weather_data(request.date, request.location)
    return result

# 4. 서버 실행 설정: __main__과 IP 주소에 따옴표, if문에 콜론(:) 필수
if __name__ == "__main__":
    import uvicorn
    # host 주소는 문자열("0.0.0.0")로 넣어야 합니다
    uvicorn.run(app, host="0.0.0.0", port=8000)