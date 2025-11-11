import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot, collection, query } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- 상수 및 전역 변수 ---
const COLLECTION_NAME = "linger_data"; // Firestore 컬렉션 이름
const GPS_UPDATE_INTERVAL = 2000; // 2초마다 위치 기록
const STATIONARY_THRESHOLD_M = 3.0; // **[수정]** 반경 3미터로 허용 오차 확대 (GPS 드리프트 대응)
const TIME_14S = 14000; // 14초 (밀리초)
const TIME_30S = 30000; // 30초 (밀리초)
const DOT_SIZE_SMALL = 8;
const DOT_SIZE_LARGE = 14;

let db, auth;
let currentUserId = 'MOCK_USER';
let gpsWatcherId = null; // watchPosition의 ID
let isWritingGps = false;

let allTrackedPoints = {}; // 모든 사용자 ID의 최신 점 데이터 { userId: {lat, lng, x, y, time, status}, ... }
let localHistory = []; // GPS 데이터를 기록하는 장치(휴대폰)의 로컬 위치 기록 (머무름 계산용)
let referenceLat = null; // 맵 좌표계의 기준 위도
let referenceLng = null; // 맵 좌표계의 기준 경도

// UI 요소
let statusP, userIdP, roleP, toggleGpsBtn;

// --- p5.js 설정 ---

window.setup = function() {
  createCanvas(windowWidth, windowHeight);
  background(240);
  
  // UI 요소 연결 (index.html의 div는 캔버스 위에 오버레이됨)
  statusP = select('#status-p');
  userIdP = select('#user-id-p');
  roleP = select('#role-p');
  toggleGpsBtn = select('#toggle-gps-btn');
  
  if (toggleGpsBtn) {
    toggleGpsBtn.elt.onclick = toggleGpsTracking;
  }

  // Firebase 초기화 및 인증 시작
  initializeFirebase();
}

window.draw = function() {
  // 캔버스 크기 조정
  resizeCanvas(windowWidth, windowHeight);
  
  // 배경을 반복해서 그려 이전 프레임을 지웁니다.
  background(240); 
  
  // 모든 사용자의 점들을 그립니다.
  drawAllPoints();
  
  // 맵 좌표 기준점 시각화 (선택 사항: 중앙에 작은 X)
  if (referenceLat !== null) {
      stroke(150, 150, 150);
      line(width/2 - 10, height/2, width/2 + 10, height/2);
      line(width/2, height/2 - 10, width/2, height/2 + 10);
  }
}

// --- Firebase 초기화 및 인증 ---

async function initializeFirebase() {
  // Canvas 환경 변수 또는 GitHub Pages 전역 변수 확인
  const firebaseConfig = typeof window.firebaseConfig !== 'undefined' 
      ? window.firebaseConfig 
      : (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null);
  
  const appId = typeof window.__app_id !== 'undefined' ? window.__app_id : 'default-plis-app';

  if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('YOUR_ACTUAL_API_KEY')) {
      // Mock Mode 설정 (Firebase 설정이 없거나 유효하지 않을 때)
      statusP.html("상태: Firebase 설정 누락 (Mock Mode)");
      userIdP.html("User ID: MOCK_USER");
      roleP.html("역할: 로컬 GPS 시뮬레이션");
      currentUserId = 'MOCK_USER';
      
      // Firestore/Auth 객체 대신 더미 함수 할당 (오류 방지)
      db = { mock: true };
      auth = { currentUser: { uid: currentUserId } }; 
      
      // Mock 모드일 경우 GPS 기능이 실행되도록 허용
      return;
  }

  try {
    setLogLevel('error'); // Firebase 로그 레벨 설정 (오류만 출력)
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);

    // 익명 로그인 시도 (가장 간단한 인증 방법)
    const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
    
    if (token) {
        await signInWithCustomToken(auth, token);
    } else {
        await signInAnonymously(auth);
    }

    currentUserId = auth.currentUser.uid;
    userIdP.html(`User ID: ${currentUserId.substring(0, 8)}...`);
    statusP.html("상태: Firebase 연결 및 인증 완료.");
    
    // 인증이 완료되면 데이터베이스 리스너를 시작합니다.
    startFirestoreListener();
    
  } catch (error) {
    statusP.html(`상태: Firebase 오류 - ${error.code}`);
    console.error("Firebase 초기화 오류:", error);
  }
}

// --- Firestore 데이터 동기화 (노트북/읽는 역할) ---

function startFirestoreListener() {
    statusP.html("상태: 실시간 데이터 구독 시작...");
    roleP.html("역할: 데이터 맵 뷰어");

    // 'linger_data' 컬렉션 전체를 구독하여 모든 사용자의 최신 위치를 실시간으로 받습니다.
    onSnapshot(collection(db, COLLECTION_NAME), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const data = change.doc.data();
                const userId = data.userId;
                
                const point = {
                    lat: data.lat,
                    lng: data.lng,
                    timestamp: data.timestamp,
                    stationaryTime: data.stationaryTime || 0,
                    status: data.status || 0 // 0:파랑, 1:빨강(14s), 2:빨강(30s+)
                };
                
                // Firestore에서 받은 데이터를 캔버스 좌표로 변환
                const screenCoords = gpsToScreen(point.lat, point.lng);
                point.x = screenCoords.x;
                point.y = screenCoords.y;
                
                // allTrackedPoints에 최신 위치를 저장 (덮어쓰기)
                allTrackedPoints[userId] = point;
            }
        });
        // 데이터가 업데이트될 때마다 캔버스를 다시 그립니다.
        redraw();
    });
}

// --- GPS 위치 추적 (휴대폰/쓰는 역할) ---

function toggleGpsTracking() {
  if (isWritingGps) {
    // 추적 중지
    if (gpsWatcherId !== null) {
      clearInterval(gpsWatcherId); // setInterval 중지
      gpsWatcherId = null;
    }
    // [추가] 로컬 기록 초기화
    localHistory = [];
    isWritingGps = false;
    toggleGpsBtn.html("GPS 추적 시작 (핸드폰 센서 사용)");
    statusP.html("상태: GPS 추적 중지됨.");
    roleP.html("역할: 데이터 맵 뷰어");
  } else {
    // 추적 시작
    if ("geolocation" in navigator) {
      roleP.html("역할: GPS 데이터 송신기");
      toggleGpsBtn.html("GPS 추적 중지");
      isWritingGps = true;
      statusP.html("상태: GPS 권한 요청 중...");
      
      // [수정] watchPosition 대신 getCurrentPosition과 setInterval 조합을 사용
      // watchPosition은 OS 레벨에서 위치가 변경될 때마다 호출되므로, 
      // GPS_UPDATE_INTERVAL(2초) 간격의 정확한 데이터 기록을 위해 setInterval을 사용합니다.
      
      // 초기 호출 및 2초마다 반복 설정
      navigator.geolocation.getCurrentPosition(handleGpsSuccess, handleGpsError, { enableHighAccuracy: true });
      gpsWatcherId = setInterval(() => {
          navigator.geolocation.getCurrentPosition(handleGpsSuccess, handleGpsError, { enableHighAccuracy: true });
      }, GPS_UPDATE_INTERVAL); // 2초 간격 타이머
      
    } else {
      statusP.html("상태: GPS API를 지원하지 않는 브라우저입니다.");
      console.error("Geolocation is not supported by this browser.");
    }
  }
}

function handleGpsSuccess(position) {
  const { latitude, longitude } = position.coords;
  const timestamp = Date.now();
  
  if (referenceLat === null) {
    // 맵의 기준점 설정 (첫 번째 받은 GPS 위치)
    referenceLat = latitude;
    referenceLng = longitude;
    statusP.html("상태: GPS 기준점 설정 완료.");
  }
  
  // 1. [로컬 기록 업데이트] 새로운 위치를 로컬 기록에 추가
  localHistory.push({ lat: latitude, lng: longitude, timestamp: timestamp });

  // 2. [머무름 시간 계산] 로컬 기록을 기반으로 머무름 시간 계산
  const stationaryTime = calculateStationaryTime();
  
  // 3. 상태 코드 결정
  let status = 0; // 0: 파랑 (기본)
  if (stationaryTime >= TIME_30S) {
    status = 2; // 2: 큰 빨강
  } else if (stationaryTime >= TIME_14S) {
    status = 1; // 1: 작은 빨강
  }

  // 4. Firestore에 데이터 쓰기 (자신의 위치와 계산된 상태를 기록)
  writeGpsData(latitude, longitude, stationaryTime, status);

  statusP.html(`상태: GPS 데이터 수집 중. 머무름: ${(stationaryTime/1000).toFixed(1)}s`);
}

function handleGpsError(error) {
  isWritingGps = false;
  toggleGpsBtn.html("GPS 추적 재시작");
  
  if (gpsWatcherId !== null) {
      clearInterval(gpsWatcherId);
      gpsWatcherId = null;
  }
  
  switch(error.code) {
    case error.PERMISSION_DENIED:
      statusP.html("상태: 위치 권한 거부됨. 추적 불가.");
      break;
    case error.POSITION_UNAVAILABLE:
      statusP.html("상태: 위치 정보 사용 불가. (GPS 비활성화)");
      break;
    case error.TIMEOUT:
      statusP.html("상태: 위치 요청 시간 초과.");
      break;
    default:
      statusP.html("상태: 알 수 없는 GPS 오류 발생.");
  }
  console.error("GPS 오류:", error);
}

// --- 데이터 쓰기 (Firestore) ---

async function writeGpsData(lat, lng, stationaryTime, status) {
  if (db.mock || !db) return; // Mock 모드 또는 연결 안됨

  // Firestore에 기록할 문서 참조 (같은 위치에 계속 덮어씁니다.)
  const docRef = doc(db, COLLECTION_NAME, currentUserId); 
  
  const data = {
      userId: currentUserId,
      lat: lat,
      lng: lng,
      timestamp: Date.now(), // Firestore 기록 시간
      stationaryTime: stationaryTime,
      status: status
  };

  try {
    await setDoc(docRef, data);
  } catch (e) {
    console.error("Firestore 쓰기 오류: ", e);
    statusP.html(`상태: Firestore 쓰기 오류 (${e.code})`);
  }
}

// --- 위치 및 거리 계산 로직 (Haversine 공식) ---

// 두 GPS 좌표 간의 거리 계산 (미터 단위)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 지구 반경 (미터)
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // 미터
}

// [수정됨] 로컬 기록을 기반으로 머무름 시간 계산
function calculateStationaryTime() {
  if (localHistory.length === 0) return 0;
  
  const now = Date.now();
  let stationaryStartTime = now;
  let foundStationary = false;
  
  // 로컬 히스토리를 역순으로 확인
  // 가장 최근 기록부터 1m 반경을 벗어난 지점까지 시간을 추적
  const latestPoint = localHistory[localHistory.length - 1];
  
  for (let i = localHistory.length - 2; i >= 0; i--) {
    const point = localHistory[i];
    // 현재 (가장 최근) 위치와 과거 기록된 위치 간의 거리 계산
    const distance = calculateDistance(latestPoint.lat, latestPoint.lng, point.lat, point.lng);
    
    if (distance <= STATIONARY_THRESHOLD_M) {
      // 3m 반경 이내에 있음: 머무름 시간이 시작된 시점을 기록
      stationaryStartTime = point.timestamp;
      foundStationary = true;
    } else {
      // 3m 밖으로 이동: 이전의 머무름이 끊어졌으므로 중단
      break; 
    }
  }
  
  // 불필요한 과거 기록 정리 (최근 1분 데이터만 남김)
  const cleanUpTime = now - 60000;
  localHistory = localHistory.filter(p => p.timestamp > cleanUpTime);

  if (foundStationary) {
    // 가장 오래된 안정된 시간부터 현재까지의 누적 시간
    return now - stationaryStartTime; 
  }
  
  return 0; // 움직임이 감지되어 초기화
}

// GPS 좌표를 캔버스 좌표로 변환
function gpsToScreen(lat, lng) {
  // 기준점이 없으면 화면 중앙을 기준으로 설정
  if (referenceLat === null || referenceLng === null) {
    referenceLat = lat;
    referenceLng = lng;
    return { x: width/2, y: height/2 };
  }
  
  // 기준점으로부터의 상대 거리 (미터)
  const dx_m = calculateDistance(referenceLat, referenceLng, referenceLat, lng);
  const dy_m = calculateDistance(referenceLat, referenceLng, lat, referenceLng);
  
  // 맵 스케일링 (1m를 50픽셀로 가정)
  const PIXELS_PER_METER = 50; 
  
  // 픽셀 거리 계산
  let dx_px = dx_m * PIXELS_PER_METER;
  let dy_px = dy_m * PIXELS_PER_METER;
  
  // 방향 보정: 경도(lng) 증가는 X 증가 (오른쪽), 위도(lat) 증가는 Y 감소 (위쪽)
  const lngDiff = lng - referenceLng;
  const latDiff = lat - referenceLat;

  if (lngDiff < 0) dx_px *= -1; // 서쪽으로 이동
  if (latDiff > 0) dy_px *= -1; // 북쪽으로 이동

  const screenX = width / 2 + dx_px;
  const screenY = height / 2 + dy_px;
  
  return { x: screenX, y: screenY };
}


// --- 시각화 함수 ---

function drawAllPoints() {
    // 모든 사용자의 데이터를 반복
    for (const userId in allTrackedPoints) {
        if (allTrackedPoints.hasOwnProperty(userId)) {
            const point = allTrackedPoints[userId];
            
            const { x, y, status, stationaryTime } = point;
            
            let dotColor;
            let dotSize;
            
            // 상태 코드에 따른 색상 및 크기 설정
            if (status === 2) {
                dotColor = [255, 0, 0]; // 빨간색 (30초 이상)
                dotSize = DOT_SIZE_LARGE;
            } else if (status === 1) {
                dotColor = [255, 165, 0]; // 주황색 (14초 이상)
                dotSize = DOT_SIZE_SMALL;
            } else {
                dotColor = [0, 0, 255]; // 파란색 (기본)
                dotSize = DOT_SIZE_SMALL;
            }
            
            // 점 그리기
            noStroke();
            fill(dotColor[0], dotColor[1], dotColor[2], 200); 
            ellipse(x, y, dotSize);

            // 사용자 ID 및 머무름 시간 라벨
            fill(0);
            textSize(12);
            textAlign(CENTER, TOP);
            
            let labelText = `ID: ${userId.substring(0, 4)}...`;
            if (userId === currentUserId) {
                 labelText = `ME: ${((stationaryTime || 0) / 1000).toFixed(0)}s`;
            } else {
                 labelText += ` - ${((stationaryTime || 0) / 1000).toFixed(0)}s`;
            }
            
            text(labelText, x, y + dotSize / 2 + 5);
        }
    }
}


// 캔버스 크기 조정 핸들러
window.windowResized = function() {
  resizeCanvas(windowWidth, windowHeight);
}