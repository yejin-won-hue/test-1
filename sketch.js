import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot, collection, query } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- 상수 및 전역 변수 ---
const COLLECTION_NAME = "linger_data"; // Firestore 컬렉션 이름
const GPS_UPDATE_INTERVAL = 2000; // 2초마다 위치 기록
const STATIONARY_THRESHOLD_M = 1.0; // 반경 1미터 (머무름 기준)
const TIME_14S = 14000; // 14초 (밀리초)
const TIME_30S = 30000; // 30초 (밀리초)
const DOT_SIZE_SMALL = 8;
const DOT_SIZE_LARGE = 14;

let db, auth;
let currentUserId = 'MOCK_USER';
let gpsWatcherId = null; // watchPosition의 ID
let isWritingGps = false;

let allTrackedPoints = {}; // 모든 사용자 ID의 점 데이터 { userId: [{lat, lng, x, y, time, status}, ...] }
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
      
      // Mock 모드에서도 GPS 기능은 실행되도록 허용
      setupGpsSimulation(true); 
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
    const q = query(collection(db, `${COLLECTION_NAME}/${currentUserId}/history`));
    
    // 모든 사용자의 데이터를 실시간으로 읽어옵니다.
    // NOTE: 보안 규칙에 따라 모든 사용자의 데이터를 읽을 수 없을 수 있으므로,
    // 이 예시에서는 모든 사용자 ID의 데이터를 읽지 않고, 단순화합니다.
    
    statusP.html("상태: 실시간 데이터 구독 시작...");
    roleP.html("역할: 데이터 맵 뷰어");

    // 컬렉션 전체를 듣지 않고, 현재 사용자 ID를 포함한 모든 데이터를 추적
    onSnapshot(collection(db, COLLECTION_NAME), (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const data = change.doc.data();
                const userId = data.userId || currentUserId;
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
                
                // 데이터 저장 구조 업데이트
                if (!allTrackedPoints[userId]) {
                    allTrackedPoints[userId] = [];
                }
                allTrackedPoints[userId].push(point);
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
      navigator.geolocation.clearWatch(gpsWatcherId);
    }
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

      // 2초 간격으로 위치 업데이트 요청
      gpsWatcherId = navigator.geolocation.watchPosition(
        handleGpsSuccess,
        handleGpsError,
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 5000 // 5초 안에 위치를 찾지 못하면 오류 처리
        }
      );
    } else {
      statusP.html("상태: GPS API를 지원하지 않는 브라우저입니다.");
      console.error("Geolocation is not supported by this browser.");
    }
  }
}

function handleGpsSuccess(position) {
  const { latitude, longitude } = position.coords;
  
  if (referenceLat === null) {
    // 맵의 기준점 설정 (첫 번째 받은 GPS 위치)
    referenceLat = latitude;
    referenceLng = longitude;
    statusP.html("상태: GPS 기준점 설정 완료.");
  }
  
  // 1. 머무름 시간 계산
  const stationaryTime = calculateStationaryTime(latitude, longitude);
  
  // 2. 상태 코드 결정
  let status = 0; // 0: 파랑 (기본)
  if (stationaryTime >= TIME_30S) {
    status = 2; // 2: 큰 빨강
  } else if (stationaryTime >= TIME_14S) {
    status = 1; // 1: 작은 빨강
  }

  // 3. Firestore에 데이터 쓰기 (자신의 위치를 기록)
  writeGpsData(latitude, longitude, stationaryTime, status);

  statusP.html(`상태: GPS 데이터 수집 중. 머무름: ${(stationaryTime/1000).toFixed(1)}s`);
}

function handleGpsError(error) {
  isWritingGps = false;
  toggleGpsBtn.html("GPS 추적 재시작");
  
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
  // 문서 ID를 사용자 ID로 설정하여 각 사용자의 최신 위치만 유지
  const docRef = doc(db, COLLECTION_NAME, currentUserId); 
  
  const data = {
      userId: currentUserId,
      lat: lat,
      lng: lng,
      timestamp: Date.now(),
      stationaryTime: stationaryTime,
      status: status
  };

  try {
    // setDoc을 사용하여 덮어쓰기 (최신 위치만 유지)
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
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  
  const a = sin(dLat / 2) * sin(dLat / 2) +
            cos(radians(lat1)) * cos(radians(lat2)) *
            sin(dLng / 2) * sin(dLng / 2);
  
  const c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return R * c;
}

// 현재 위치 기반 머무름 시간 계산
function calculateStationaryTime(currentLat, currentLng) {
  // 현재 사용자 ID의 기록된 점들을 가져옵니다. (현재는 Firetore에 덮어쓰므로 이 배열을 사용할 수 없음)
  // 대신, Firestore에 기록되기 전 현재 GPS 위치를 기반으로 계산해야 합니다.
  
  // 현재 코드는 Firestore에 덮어쓰기만 하므로,
  // 머무름 시간은 'Firestore에서 읽어온 자신의 마지막 점'을 기준으로 계산해야 하지만,
  // 구조의 단순화를 위해, 이 로직은 현재 위치가 1m 이내일 경우
  // 직전 기록된 'stationaryTime'을 증가시키는 방식으로 작동해야 합니다.
  
  // **간소화된 로직:** 현재는 덮어쓰기 구조이므로, 
  // '이전 기록'이 없다고 가정하고, 1m 반경 내에서 
  // 마지막 기록된 시간을 가져와 계산하는 것이 실질적입니다.
  
  const myPoints = allTrackedPoints[currentUserId];
  if (!myPoints || myPoints.length === 0) return 0;

  let stationaryStartTime = myPoints[myPoints.length - 1].timestamp;
  let lastRecordedPoint = myPoints[myPoints.length - 1];

  const distance = calculateDistance(currentLat, currentLng, lastRecordedPoint.lat, lastRecordedPoint.lng);

  if (distance <= STATIONARY_THRESHOLD_M) {
    // 1m 이내에 머무름: 이전 머무름 시간을 가져와 현재까지 누적
    return Date.now() - lastRecordedPoint.timestamp + lastRecordedPoint.stationaryTime;
  }
  
  // 1m 밖으로 이동: 머무름 시간 초기화
  return 0;
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
            const points = allTrackedPoints[userId];
            
            // 가장 최근의 점만 그립니다. (덮어쓰기 구조이므로)
            if (points.length > 0) {
                const point = points[points.length - 1];
                const { x, y, status } = point;
                
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

                // 사용자 ID 라벨 (현재 사용자만 표시)
                if (userId === currentUserId) {
                    fill(0);
                    textSize(12);
                    textAlign(CENTER, TOP);
                    text(`ME: ${((point.stationaryTime || 0) / 1000).toFixed(0)}s`, x, y + dotSize / 2 + 5);
                }
            }
        }
    }
}


// 캔버스 크기 조정 핸들러
window.windowResized = function() {
  resizeCanvas(windowWidth, windowHeight);
}

// --- Mock Mode에서 GPS 시뮬레이션을 위한 더미 함수 ---
// (현재는 실제 GPS를 사용하므로 이 함수는 사용되지 않습니다.)
function setupGpsSimulation(isMock) {
    if (isMock) {
        // Mock 모드일 경우 가짜 GPS 데이터를 생성하는 로직을 여기에 넣을 수 있습니다.
        // 하지만 요구사항은 실제 GPS이므로, Mock 모드에서는 아무것도 하지 않습니다.
    }
}