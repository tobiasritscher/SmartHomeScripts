let CONFIG = {
    scan_duration: BLE.Scanner.INFINITE_SCAN,
    temperature_thr: 18,
    switch_id: 0,
    mqtt_topic: "ruuvi",
    event_name: "ruuvi.measurement",
  };
  
  let RUUVI_MFD_ID = 0x0499;
  let RUUVI_DATA_FMT = 5;

  let lastMeasurements = new Array;
  lastMeasurements[0] = 0;
  let index = 0;

  let macAddressesToNames = {
    "eb:74:09:96:b6:45": "Balkon",
    "ee:23:03:26:97:e4": "Fenster",
    "da:59:e0:68:b3:95": "Wohnzimmer"
  };

  
  //format is subset of https://docs.python.org/3/library/struct.html
  let packedStruct = {
    buffer: '',
    setBuffer: function(buffer) {
      this.buffer = buffer;
    },
    utoi: function(u16) {
      return (u16 & 0x8000) ? u16 - 0x10000 : u16;
    },
    getUInt8: function() {
      return this.buffer.at(0)
    },
    getInt8: function() {
      let int = this.getUInt8();
      if(int & 0x80) int = int - 0x100;
      return int;
    },
    getUInt16LE: function() {
      return 0xffff & (this.buffer.at(1) << 8 | this.buffer.at(0));
    },
    getInt16LE: function() {
      return this.utoi(this.getUInt16LE());
    },
    getUInt16BE: function() {
      return 0xffff & (this.buffer.at(0) << 8 | this.buffer.at(1));
    },
    getInt16BE: function() {
      return this.utoi(this.getUInt16BE(this.buffer));
    },
    unpack: function(fmt, keyArr) {
      let b = '<>!';
      let le = fmt[0] === '<';
      if(b.indexOf(fmt[0]) >= 0) {
        fmt = fmt.slice(1);
      }
      let pos = 0;
      let jmp;
      let bufFn;
      let res = {};
      while(pos<fmt.length && pos<keyArr.length && this.buffer.length > 0) {
        jmp = 0;
        bufFn = null;
        if(fmt[pos] === 'b' || fmt[pos] === 'B') jmp = 1;
        if(fmt[pos] === 'h' || fmt[pos] === 'H') jmp = 2;
        if(fmt[pos] === 'b') {
          res[keyArr[pos]] = this.getInt8();
        }
        else if(fmt[pos] === 'B') {
          res[keyArr[pos]] = this.getUInt8();
        }
        else if(fmt[pos] === 'h') {
          res[keyArr[pos]] = le ? this.getInt16LE() : this.getInt16BE();
        }
        else if(fmt[pos] === 'H') {
          res[keyArr[pos]] = le ? this.getUInt16LE() : this.getUInt16BE();
        }
        this.buffer = this.buffer.slice(jmp);
        pos++;
      }
      return res;
    }
  };
  
  let RuuviParser = {
    getData: function (res) {
      let data = BLE.GAP.ParseManufacturerData(res.advData);
      if (typeof data !== "string" || data.length < 26) return null;
      packedStruct.setBuffer(data);
      let hdr = packedStruct.unpack('<HB', ['mfd_id', 'data_fmt']);
      if(hdr.mfd_id !== RUUVI_MFD_ID) return null;
      if(hdr.data_fmt !== RUUVI_DATA_FMT) {
        print("unsupported data format from", res.addr);
        print("expected format", RUUVI_DATA_FMT);
        return null;
      };
    
      let rm = packedStruct.unpack('>hHHhhhHBHBBBBBB', [
        'temp',
        'humidity',
        'pressure',
        'acc_x',
        'acc_y',
        'acc_z',
        'pwr',
        'cnt',
        'sequence',
        'mac_0','mac_1','mac_2','mac_3','mac_4','mac_5'
      ]);

      var temp = rm.temp * 0.005;
      index = (index + 1) % 10;
      lastMeasurements[index] = temp;

      let payload = {
        "temperature": rm.temp * 0.005,
        "humidity": rm.humidity * 0.0025,
        "pressure": rm.pressure + 50000,
        "battery": (rm.pwr >> 5) + 1600,
        "txdbm": (rm.pwr & 0x001f * 2) - 40,
        "addr": res.addr,
        "rssi": res.rssi,
        "tempRising": getTempRising(temp)
      }
      return payload;
    },
  };

  function averageLastMeasurements() {
    if (lastMeasurements.length < 2) {
        return -30.0;
    }

    let sum = 0.0;

    for(let i = 0; i < lastMeasurements.length; i++) {
        sum += lastMeasurements[i];
    }

    return sum / lastMeasurements.length;
  }

  function getTempRising(temp) {
    return temp > averageLastMeasurements();
  }
  
  function publishToMqtt(measurement) {
    var topic = "/" + macAddressesToNames[measurement.addr] + "/state";
    console.log("publish topic: ", topic);
    MQTT.publish(
      topic,
      JSON.stringify(measurement)
    );
  }

  function publishDiscovery(mac) {
    var MqttDiscovery = function(deviceClass, unitOfMeasurement, format) {
        this.deviceClass = deviceClass;
        this.unitOfMeasurement = unitOfMeasurement;
        this.format = format;
    };
    var mqttDiscovery = [];

    mqttDiscovery.push(new MqttDiscovery("pressure","hPa","|float|round(1)"));
    mqttDiscovery.push(new MqttDiscovery("humidity","%","|float|round(1)"));
    mqttDiscovery.push(new MqttDiscovery("temperature","°C","|float|round(2)"));
    mqttDiscovery.push(new MqttDiscovery("battery","V","|float|round(2)"));
    mqttDiscovery.push(new MqttDiscovery("tempRising","bool","bool"));

    for (var i = 0; i < mqttDiscovery.length; i++) {
        var m = mqttDiscovery[i];
        var topic = "homeassistant/sensor/"+mac+"/"+m.deviceClass+"/config";

        var payload = "{" +
            "\"unit_of_meas\":\"" + m.unitOfMeasurement + "\"," +
            "\"dev_cla\":\"" + m.deviceClass + "\"," +
            "\"val_tpl\":\"{{value_json." + m.deviceClass + m.format + "}}\"," +
            "\"stat_t\":\"" + "/" + mac + "/state\"," +
            "\"name\":\"" + mac + "_" + m.deviceClass + "\"," +
            "\"uniq_id\":\"" + mac + "_" + m.deviceClass + "\"," +
            "\"dev\":{" +
            "\"ids\":[\"" + mac + "\"]," +
            "\"name\":\"Ruuvitag " + mac + "\"," +
            "\"mdl\":\"Ruuvitag vX\"," +
            "\"mf\":\"Ruuvi Innovations Oy\"}}";
            
        MQTT.publish(topic, payload);
        print("ruuvi discovery: ", topic)
    }
    
}
  
  function scanCB(ev, res) {
    if (ev !== BLE.Scanner.SCAN_RESULT) return;
    let measurement = RuuviParser.getData(res);
    if (measurement === null) return;
    print("ruuvi measurement:", JSON.stringify(measurement));
    //publishDiscovery(macAddressesToNames[measurement.addr]);
    publishToMqtt(measurement);
  }
  
  BLE.Scanner.Start({ duration_ms: CONFIG.scan_duration }, scanCB);
