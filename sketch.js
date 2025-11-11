// BLE 통신을 위한 고유 식별자 (아두이노의 코드와 일치해야 합니다)
const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"; 

// 1. 아두이노로 명령어 전송 (기존 WRITE_UUID)
const WRITE_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"; 

// 2. 아두이노에서 위치/머무름 데이터 수신 (READ UUID 정의 - 아두이노와 맞춰야 함)
// 아두이노 코드에서 머무름 데이터를 이 UUID로 전송해야 합니다.
const READ_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214"; 

let writeChar, readChar, statusP, connectBtn;

// --- GPS 추적 데이터 ---
let gpsPoints = []; // [{ lat, lng, x, y, timestamp, stationaryTime }]
let lastGpsUpdate = 0;
const UPDATE_INTERVAL = 2000; // 2초마다 업데이트
const STATIONARY_THRESHOLD = 1.0; // 1미터 반경
const STATIONARY_TIME_14S = 14000; // 14초 (밀리초)
const STATIONARY_TIME_30S = 30000; // 30초 (밀리초)

// 기준 위치 (첫 GPS 좌표를 기준으로 설정)
let referenceLat = null;
let referenceLng = null;
const PIXELS_PER_METER = 100; // 1미터당 픽셀 수

function setup() {
  createCanvas(windowWidth, windowHeight);
  background(255); // 배경색 설정

  // BLE 연결 버튼 (기존 UI 유지)
  connectBtn = createButton("Scan & Connect");
  connectBtn.mousePressed(connectAny);
  connectBtn.size(120, 30);
  connectBtn.position(20, 40);

  // 상태 표시 요소
  statusP = createP("Status: Not connected");
  statusP.position(22, 60);

  // draw 루프는 데이터를 받아 화면을 실시간 업데이트해야 하므로 계속 실행합니다.
}

function draw() {
  // 매 프레임마다 배경을 다시 그려서 잔상을 남기지 않도록 합니다.
  background(240); // 맵 배경색
  
  // 상태 메시지 표시를 위한 배경
  fill(255);
  rect(0, 0, width, 120); 

  // 상태 메시지 텍스트
  fill(0);
  textSize(14);
  text(statusP.html(), 22, 85);
  text(`Total Points: ${gpsPoints.length}`, 22, 105);
  
  // --- GPS 점들 그리기 ---
  gpsPoints.forEach(point => {
    const { x, y, stationaryTime } = point;
    
    noStroke();
    
    // 정지 시간에 따라 색상과 크기 결정
    let dotColor;
    let dotSize;
    
    if (stationaryTime >= STATIONARY_TIME_30S) {
      // 30초 이상: 지름 5인 빨간색 점
      dotColor = [255, 0, 0]; // 빨간색
      dotSize = 5;
    } else if (stationaryTime >= STATIONARY_TIME_14S) {
      // 14초 이상: 지름 2인 빨간색 점
      dotColor = [255, 0, 0]; // 빨간색
      dotSize = 2;
    } else {
      // 기본: 지름 2인 파란색 점
      dotColor = [0, 0, 255]; // 파란색
      dotSize = 2;
    }
    
    fill(dotColor[0], dotColor[1], dotColor[2]);
    ellipse(x, y, dotSize);
  });
}

// 두 GPS 좌표 간의 거리 계산 (미터 단위, Haversine 공식)
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

// GPS 좌표를 화면 좌표로 변환
function gpsToScreen(lat, lng) {
  if (referenceLat === null || referenceLng === null) {
    referenceLat = lat;
    referenceLng = lng;
  }
  
  // 기준점으로부터의 상대적 거리 계산
  const dx = calculateDistance(referenceLat, referenceLng, referenceLat, lng);
  const dy = calculateDistance(referenceLat, referenceLng, lat, referenceLng);
  
  // 방향 보정 (경도가 증가하면 오른쪽, 위도가 증가하면 아래쪽)
  const lngDiff = lng - referenceLng;
  const latDiff = lat - referenceLat;
  
  const screenX = width / 2 + (lngDiff > 0 ? 1 : -1) * dx * PIXELS_PER_METER;
  const screenY = height / 2 + (latDiff > 0 ? 1 : -1) * dy * PIXELS_PER_METER;
  
  return { x: screenX, y: screenY };
}

// 정지 시간 계산
function calculateStationaryTime(currentLat, currentLng) {
  if (gpsPoints.length === 0) return 0;
  
  const now = Date.now();
  let stationaryStartTime = now;
  let foundStationary = false;
  
  // 역순으로 확인하여 가장 오래된 같은 위치의 시간 찾기
  for (let i = gpsPoints.length - 1; i >= 0; i--) {
    const point = gpsPoints[i];
    const distance = calculateDistance(currentLat, currentLng, point.lat, point.lng);
    
    if (distance <= STATIONARY_THRESHOLD) {
      // 같은 위치에 있음 (반경 1m 이내)
      stationaryStartTime = point.timestamp;
      foundStationary = true;
    } else {
      // 다른 위치에 있으면 중단
      break;
    }
  }
  
  if (foundStationary) {
    return now - stationaryStartTime;
  }
  
  return 0;
}

// ---- BLE Connect (수정됨: Read Characteristic 추가) ----
async function connectAny() {
  try {
    // 1. 장치 검색 및 연결 요청
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    
    // 2. WRITE Characteristic 설정 (아두이노로 명령어 전송용)
    writeChar = await service.getCharacteristic(WRITE_UUID);
    
    // 3. READ Characteristic 설정 및 알림 구독 (아두이노에서 데이터 수신용)
    readChar = await service.getCharacteristic(READ_UUID);
    await readChar.startNotifications(); // 아두이노가 데이터를 보낼 때마다 알림 요청
    
    // 4. 데이터가 변경될 때마다 handleData 함수 호출
    readChar.addEventListener('characteristicvaluechanged', handleData); 
    
    statusP.html("Status: Connected to " + (device.name || "device") + " & Subscribed to GPS data.");
  } catch (e) {
    statusP.html("Status: Error - " + e);
    console.error(e);
  }
}

// ---- BLE Data Handler (수신된 GPS 데이터를 처리하고 시각화) ----
function handleData(event) {
  const value = event.target.value;
  const now = Date.now();
  
  // 2초마다만 업데이트
  if (now - lastGpsUpdate < UPDATE_INTERVAL) {
    return;
  }
  
  // GPS 데이터 파싱
  // 형식 1: Float32 두 개 (latitude, longitude) = 8바이트
  if (value.byteLength >= 8) {
    const lat = value.getFloat32(0, true); // little-endian
    const lng = value.getFloat32(4, true);
    
    // 유효한 GPS 좌표인지 확인 (위도: -90~90, 경도: -180~180)
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      // 정지 시간 계산
      const stationaryTime = calculateStationaryTime(lat, lng);
      
      // 화면 좌표로 변환
      const screenPos = gpsToScreen(lat, lng);
      
      // 점 추가
      gpsPoints.push({
        lat: lat,
        lng: lng,
        x: screenPos.x,
        y: screenPos.y,
        timestamp: now,
        stationaryTime: stationaryTime
      });
      
      lastGpsUpdate = now;
      
      statusP.html(`GPS: Lat=${lat.toFixed(6)}, Lng=${lng.toFixed(6)}, Stationary: ${(stationaryTime/1000).toFixed(1)}s`);
    } else {
      statusP.html("GPS: Invalid coordinates received.");
    }
  } 
  // 형식 2: Int16 두 개로 스케일된 좌표 (기존 형식과 호환)
  else if (value.byteLength >= 4) {
    const lat_raw = value.getInt16(0, true);
    const lng_raw = value.getInt16(2, true);
    
    // 스케일을 실제 GPS 좌표로 변환 (예: 10000으로 나누어서)
    // 이 값은 아두이노에서 보내는 스케일에 맞게 조정해야 합니다
    const lat = lat_raw / 10000.0;
    const lng = lng_raw / 10000.0;
    
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      const stationaryTime = calculateStationaryTime(lat, lng);
      const screenPos = gpsToScreen(lat, lng);
      
      gpsPoints.push({
        lat: lat,
        lng: lng,
        x: screenPos.x,
        y: screenPos.y,
        timestamp: now,
        stationaryTime: stationaryTime
      });
      
      lastGpsUpdate = now;
      statusP.html(`GPS: Lat=${lat.toFixed(6)}, Lng=${lng.toFixed(6)}, Stationary: ${(stationaryTime/1000).toFixed(1)}s`);
    } else {
      statusP.html("GPS: Invalid coordinates received.");
    }
  } else {
    statusP.html("GPS: Received incomplete data packet.");
  }
}

// ---- Write 1 byte to BLE ---- (기존 함수 유지)
async function sendNumber(n) {
  if (!writeChar) {
    statusP.html("Status: Not connected");
    return;
  }
  try {
    await writeChar.writeValue(new Uint8Array([n & 0xff]));
  } catch (e) {
    statusP.html("Status: Write error - " + e);
    console.error(e);
  }
}

// 캔버스 크기 조정 핸들러
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}