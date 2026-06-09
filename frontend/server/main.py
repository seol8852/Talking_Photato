from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from crawler import get_weather_data

app = FastAPI()

# 프론트엔드와 통신을 위한 CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # 개발 중에는 모든 오리진 허용
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class WeatherRequest(BaseModel):
    date: str
    location: str

@app.post("/get-weather")
async def fetch_weather(request: WeatherRequest):
    """
    프론트엔드에서 날짜와 지역명을 받아 기상 데이터를 반환합니다.
    """
    result = get_weather_data(request.date, request.location)
    return result

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
